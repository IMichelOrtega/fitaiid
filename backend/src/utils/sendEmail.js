// backend/src/utils/sendEmail.js

function verificationEmailHtml({ name, verifyUrl }) {
  return `
    <div style="margin: 0; padding: 40px 20px; background-color: #0b0d17; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ffffff;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #111827; border: 1px solid rgba(255, 42, 42, 0.3); border-radius: 16px; overflow: hidden; box-shadow: 0 4px 30px rgba(255, 0, 0, 0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(90deg, #ff0000 0%, #ff7a00 100%); padding: 30px 20px; text-align: center;">
          <h1 style="margin: 0; color: #ffffff; font-size: 28px; letter-spacing: 2px; text-transform: uppercase;">FITAIID</h1>
        </div>

        <!-- Body -->
        <div style="padding: 40px 30px; text-align: center;">
          <h2 style="margin-top: 0; color: #ffffff; font-size: 24px;">¡Hola, ${name || 'futuro atleta'}! 🏋️‍♂️</h2>
          <p style="color: #d1d5db; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
            Estás a un solo paso de transformar tu vida. Gracias por unirte a <strong>FitAiid</strong>, la plataforma definitiva para alcanzar tus metas de fitness y nutrición.
          </p>
          
          <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(90deg, #ff0000 0%, #ff7a00 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; font-size: 16px; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 15px rgba(255, 0, 0, 0.4); margin-bottom: 25px;">
            🔥 VERIFICAR MI CUENTA 🔥
          </a>

          <p style="color: #9ca3af; font-size: 14px; margin-bottom: 10px;">O copia y pega este enlace en tu navegador:</p>
          <div style="background-color: #0b0d17; padding: 12px; border-radius: 6px; word-break: break-all; border: 1px solid #374151;">
            <a href="${verifyUrl}" style="color: #ef4444; font-size: 13px; text-decoration: none;">${verifyUrl}</a>
          </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #060810; padding: 20px; text-align: center; border-top: 1px solid rgba(255, 42, 42, 0.15);">
          <p style="margin: 0; color: #6b7280; font-size: 12px;">
            Si no solicitaste crear esta cuenta, puedes ignorar este correo de forma segura.
          </p>
          <p style="margin: 10px 0 0; color: #4b5563; font-size: 12px;">
            © ${new Date().getFullYear()} FitAiid. Todos los derechos reservados.
          </p>
        </div>

      </div>
    </div>
  `;
}

async function sendVerificationEmail(to, name, verifyUrl) {
  console.log("📧 Intentando enviar email a:", to);
  console.log("📧 API KEY existe?", !!process.env.MAILERSEND_API_KEY);
  try {
    console.log("📧 Llamando a MailerSend API...");
    const response = await fetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MAILERSEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: {
          email: process.env.EMAIL_USER,
          name: "FitAiid",
        },
        to: [{ email: to, name: name || "usuario" }],
        subject: "Verifica tu correo en FitAiid ✅",
        html: verificationEmailHtml({ name, verifyUrl }),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("❌ MailerSend API error:", error);
      throw new Error("Error al enviar el correo de verificación");
    }

    console.log(`📩 Correo de verificación enviado a: ${to}`);
  } catch (error) {
    console.error("❌ Error al enviar el correo:", error.message);
    console.error("❌ Stack:", error.stack);
    throw new Error("Error al enviar el correo de verificación");
  }
}

module.exports = { sendVerificationEmail };