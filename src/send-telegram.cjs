const path = require("node:path");
const { readJson } = require("./repository-scan.cjs");
const { sendAlertDigest } = require("./telegram.cjs");

async function sendRepositoryAlerts(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { sent: false, reason: "not_configured" };
  }

  const status = readJson(
    path.resolve(root, options.statusPath || "docs/data/status.json"),
    { alerts: [] },
  );
  return sendAlertDigest({
    alerts: status.alerts || [],
    token,
    chatId,
    panelUrl: options.panelUrl,
    fetchImpl: options.fetchImpl,
  });
}

if (require.main === module) {
  sendRepositoryAlerts()
    .then((result) => {
      if (result.reason === "not_configured") {
        process.stdout.write(
          "Telegram no está configurado; se omiten las alertas.\n",
        );
      } else if (result.reason === "no_alerts") {
        process.stdout.write("No hay alertas nuevas para Telegram.\n");
      } else {
        process.stdout.write("Alerta enviada a Telegram.\n");
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

module.exports = { sendRepositoryAlerts };
