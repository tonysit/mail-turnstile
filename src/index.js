
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function validEmail(email) {
  return typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    const allowedOrigins = getAllowedOrigins(env);
    const isAllowed = origin &&
      allowedOrigins.includes(origin.replace(/\/$/, ""));

    const cors = isAllowed
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        }
      : {};

    if (request.method === "OPTIONS") {
      if (!isAllowed) {
        return json({ error: "Origin not allowed" }, 403);
      }

      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        service: "mail-turnstile",
        status: "running",
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!isAllowed) {
      return json({ error: "Origin not allowed" }, 403);
    }

    if (url.pathname !== "/send") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (!env.CONTACT_RECIPIENT) {
      return json({
        error: "CONTACT_RECIPIENT is not configured",
      }, 500, cors);
    }

    if (
      !(request.headers.get("Content-Type") || "")
        .toLowerCase()
        .includes("application/json")
    ) {
      return json({
        error: "Content-Type must be application/json",
      }, 415, cors);
    }

    const contentLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (contentLength > 12000) {
      return json({ error: "Request too large" }, 413, cors);
    }

    let body;

    try {
      const raw = await request.text();

      if (new TextEncoder().encode(raw).length > 12000) {
        return json({ error: "Request too large" }, 413, cors);
      }

      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return json({ error: "Invalid request body" }, 400, cors);
    }

    const { name, email, subject, message } = body;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof subject !== "string" ||
      typeof message !== "string"
    ) {
      return json({
        error: "Please provide name, email, subject and message",
      }, 400, cors);
    }

    if (
      !name.trim() ||
      name.trim().length > 100 ||
      !validEmail(email.trim()) ||
      !subject.trim() ||
      subject.trim().length > 150 ||
      !message.trim() ||
      message.trim().length > 5000
    ) {
      return json({
        error: "Invalid form data",
      }, 400, cors);
    }

    try {
      const siteId = env.MAIL_STATE.idFromName(
        origin.replace(/\/$/, "")
      );

      const stub = env.MAIL_STATE.get(siteId);

      const result = await stub.fetch(
        "https://internal/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Site-Origin": origin,
            "X-Client-IP":
              request.headers.get("CF-Connecting-IP") || "unknown",
          },
          body: JSON.stringify({
            to: env.CONTACT_RECIPIENT,
            name: name.trim(),
            email: email.trim(),
            subject: subject.trim(),
            message: message.trim(),
          }),
        }
      );

      const data = await result.json();

      return json(data, result.status, cors);
    } catch (error) {
      console.error("Send request failed:", error.message);

      return json({
        success: false,
        error: "Mail service temporarily unavailable",
      }, 502, cors);
    }
  },
};

export class MailState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    // Serialize quota checks and token refresh operations.
    const task = () => this.handleSend(request);
    const result = this.queue.then(task, task);

    this.queue = result.catch(() => {});

    return result;
  }

  async handleSend(request) {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let mail;

    try {
      mail = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const siteOrigin = request.headers.get("X-Site-Origin");
    const clientIP = request.headers.get("X-Client-IP") || "unknown";

    if (!siteOrigin || !mail.to) {
      return json({ error: "Invalid mail request" }, 400);
    }

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const hourKey = now.toISOString().slice(0, 13);

    const dailyKey = `daily:${dateKey}`;

    // Hash IP before using it as a storage key.
    const ipHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(clientIP)
    );

    const ipId = Array.from(new Uint8Array(ipHash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const ipKey = `ip:${hourKey}:${ipId}`;

    // Per-site daily limit: 50 successful emails.
    const dailyCount =
      (await this.ctx.storage.get(dailyKey)) || 0;

    if (dailyCount >= 50) {
      return json({
        success: false,
        error: "Daily email limit reached",
        limit: 50,
      }, 429);
    }

    // Per-IP hourly limit: 5 attempts.
    const ipCount =
      (await this.ctx.storage.get(ipKey)) || 0;

    if (ipCount >= 5) {
      return json({
        success: false,
        error: "Too many requests. Please try again later.",
      }, 429);
    }

    // Count attempts even if Microsoft later rejects the email.
    await this.ctx.storage.put(ipKey, ipCount + 1);

    if (
      !this.env.MICROSOFT_CLIENT_ID ||
      !this.env.MICROSOFT_REFRESH_TOKEN
    ) {
      return json({
        success: false,
        error: "Microsoft credentials are not configured",
      }, 500);
    }

    try {
      // Use the latest rotated refresh token.
      const refreshToken =
        await this.ctx.storage.get("refresh_token") ||
        this.env.MICROSOFT_REFRESH_TOKEN;

      const tokenResponse = await fetch(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: this.env.MICROSOFT_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: "https://graph.microsoft.com/Mail.Send offline_access",
          }),
        }
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error(
          "Microsoft authentication failed:",
          tokenData.error
        );

        return json({
          success: false,
          error: "Microsoft authentication failed",
        }, 502);
      }

      // Save the latest refresh token.
      if (tokenData.refresh_token) {
        await this.ctx.storage.put(
          "refresh_token",
          tokenData.refresh_token
        );
      }

      const emailBody = [
        "New website contact form message",
        "",
        `Name: ${mail.name}`,
        `Email: ${mail.email}`,
        `Subject: ${mail.subject}`,
        "",
        "Message:",
        mail.message,
      ].join("\n");

      const profileResponse = await fetch(
        "https://graph.microsoft.com/v1.0/me",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        }
      );

      const profileData = await profileResponse.json();

      console.log("Microsoft Graph profile:", {
        id: profileData.id,
        displayName: profileData.displayName,
        mail: profileData.mail,
        userPrincipalName: profileData.userPrincipalName,
      });

      const graphResponse = await fetch(
        "https://graph.microsoft.com/v1.0/me/sendMail",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: `[Website Contact] ${mail.subject}`,
              body: {
                contentType: "Text",
                content: emailBody,
              },
              toRecipients: [
                {
                  emailAddress: {
                    address: mail.to,
                  },
                },
              ],
              replyTo: [
                {
                  emailAddress: {
                    address: mail.email,
                    name: mail.name,
                  },
                },
              ],
            },
            saveToSentItems: true,
          }),
        }
      );

      if (graphResponse.status !== 202) {
        const errorData = await graphResponse.json().catch(() => ({}));

        console.error(
          "Microsoft Graph send failed:",
          errorData.error?.code || graphResponse.status
        );

        return json({
          success: false,
          error: "Email could not be sent",
        }, 502);
      }

      // Increment daily quota only after Graph accepts the email.
      await this.ctx.storage.put(dailyKey, dailyCount + 1);

      return json({
        success: true,
        message: "Your message has been sent successfully",
        remainingToday: 49 - dailyCount,
      });

    } catch (error) {
      console.error("Mail service error:", error.message);

      return json({
        success: false,
        error: "Mail service error",
      }, 500);
    }
  }
}
