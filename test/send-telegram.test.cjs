const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  alertFingerprint,
  processTelegramUpdates,
  sendRepositoryAlerts,
} = require("../src/send-telegram.cjs");

function alert(totalPrice = 120) {
  return {
    type: "new_match",
    monitorId: "madrid",
    monitorName: "Madrid",
    offer: {
      hotelName: "Hotel Centro",
      checkIn: "2026-09-01",
      checkOut: "2026-09-03",
      nights: 2,
      totalPrice,
      nightlyPrice: totalPrice / 2,
      priceVerified: true,
      priceConfirmationCount: 2,
      source: "booking",
      url: "https://www.booking.com/example",
    },
  };
}

function fixture(t, alerts, state = { version: 1, monitors: {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-telegram-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs/data"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/data/status.json"),
    JSON.stringify({ alerts }),
  );
  fs.writeFileSync(
    path.join(root, "state/repository-state.json"),
    JSON.stringify(state),
  );
  return root;
}

test("does not resend an alert already present in the persistent ledger", async (t) => {
  const duplicate = alert();
  const root = fixture(t, [duplicate], {
    version: 1,
    monitors: {},
    telegram: {
      sentAlerts: [{
        id: alertFingerprint(duplicate),
        sentAt: "2026-08-20T12:00:00.000Z",
      }],
    },
  });
  let calls = 0;
  const result = await sendRepositoryAlerts({
    root,
    token: "secret",
    chatId: "123",
    now: new Date("2026-08-20T12:05:00.000Z"),
    remoteState: { telegram: { sentAlerts: [] } },
    processUpdates: false,
    fetchImpl: async () => {
      calls += 1;
    },
  });
  assert.equal(result.reason, "no_alerts");
  assert.equal(result.duplicatesSkipped, 1);
  assert.equal(calls, 0);
});

test("merges the remote ledger before sending an overlapping execution", async (t) => {
  const duplicate = alert();
  const root = fixture(t, [duplicate]);
  const result = await sendRepositoryAlerts({
    root,
    token: "secret",
    chatId: "123",
    now: new Date("2026-08-20T12:05:00.000Z"),
    remoteState: {
      telegram: {
        sentAlerts: [{
          id: alertFingerprint(duplicate),
          sentAt: "2026-08-20T12:04:00.000Z",
        }],
      },
    },
    processUpdates: false,
  });
  assert.equal(result.reason, "no_alerts");
  assert.equal(result.duplicatesSkipped, 1);
});

test("records a new alert only after Telegram accepts it", async (t) => {
  const fresh = alert(110);
  const root = fixture(t, [fresh]);
  const result = await sendRepositoryAlerts({
    root,
    token: "secret",
    chatId: "123",
    now: new Date("2026-08-20T12:05:00.000Z"),
    remoteState: { telegram: { sentAlerts: [] } },
    processUpdates: false,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    }),
  });
  const saved = JSON.parse(
    fs.readFileSync(path.join(root, "state/repository-state.json"), "utf8"),
  );
  assert.equal(result.sent, true);
  assert.equal(saved.telegram.sentAlerts.length, 1);
  assert.equal(saved.telegram.sentAlerts[0].id, alertFingerprint(fresh));
  assert.equal(Object.keys(saved.telegram.hotelActions).length, 1);
});

test("processes Telegram status and mute commands for the configured chat", async () => {
  const requests = [];
  const state = await processTelegramUpdates({
    telegramState: { updateOffset: 0, mutedMonitorIds: [] },
    token: "secret",
    chatId: "123",
    status: {
      updatedAt: "2026-08-20T12:00:00.000Z",
      summary: { searches: 4, offers: 8, matches: 1 },
      monitors: {
        sesimbra: {
          monitorName: "Sesimbra",
          sources: { booking: { state: "healthy" } },
        },
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/getUpdates")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 10,
                message: { chat: { id: 123 }, text: "/estado" },
              },
              {
                update_id: 11,
                message: { chat: { id: 123 }, text: "/silenciar Sesimbra" },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: requests.length } }),
      };
    },
  });
  assert.equal(state.updateOffset, 12);
  assert.deepEqual(state.mutedMonitorIds, ["sesimbra"]);
  assert.equal(requests.filter((request) => request.url.endsWith("/sendMessage")).length, 2);
});

test("persists a hotel exclusion from its Telegram button", async () => {
  const exclusions = { version: 1, updatedAt: "", hotels: [] };
  const requests = [];
  const state = await processTelegramUpdates({
    telegramState: {
      updateOffset: 0,
      mutedMonitorIds: [],
      hotelActions: {
        abc123: {
          monitorId: "madrid",
          monitorName: "Madrid centro",
          hotelName: "Hotel Centro",
          source: "booking",
          registeredAt: "2026-08-20T12:00:00.000Z",
        },
      },
    },
    exclusions,
    now: new Date("2026-08-20T12:05:00.000Z"),
    token: "secret",
    chatId: "123",
    status: { summary: {}, monitors: {} },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/getUpdates")) {
        return Response.json({
          ok: true,
          result: [{
            update_id: 30,
            callback_query: {
              id: "exclude-hotel",
              data: "exclude:abc123",
              message: { chat: { id: 123 } },
            },
          }],
        });
      }
      return Response.json({ ok: true, result: true });
    },
  });

  assert.equal(state.updateOffset, 31);
  assert.equal(exclusions.hotels.length, 1);
  assert.equal(exclusions.hotels[0].hotelName, "Hotel Centro");
  assert.equal(exclusions.hotels[0].monitorId, "madrid");
  assert.match(
    requests.find((request) => request.url.endsWith("/sendMessage")).body.text,
    /Hotel descartado: Hotel Centro/,
  );
  assert.match(
    requests.find((request) =>
      request.url.endsWith("/answerCallbackQuery")
    ).body.text,
    /descartado/,
  );
});

test("removes a discarded hotel from published data in the callback cycle", async (t) => {
  const fresh = alert(100);
  const root = fixture(t, [fresh], {
    version: 1,
    monitors: {
      madrid: {
        offers: {
          hotel: { hotelName: "Hotel Centro", matches: true },
        },
      },
    },
    telegram: {
      updateOffset: 0,
      hotelActions: {
        abc123: {
          monitorId: "madrid",
          monitorName: "Madrid",
          hotelName: "Hotel Centro",
          source: "booking",
          registeredAt: "2026-08-20T12:00:00.000Z",
        },
      },
    },
  });
  fs.writeFileSync(
    path.join(root, "docs/data/deals.json"),
    JSON.stringify({
      version: 1,
      deals: [{
        id: "madrid:hotel",
        monitorId: "madrid",
        hotelName: "Hotel Centro",
      }],
    }),
  );

  const result = await sendRepositoryAlerts({
    root,
    token: "secret",
    chatId: "123",
    now: new Date("2026-08-20T12:05:00.000Z"),
    remoteState: { telegram: {} },
    remoteExclusions: { version: 1, updatedAt: "", hotels: [] },
    fetchImpl: async (url) => {
      if (url.endsWith("/getUpdates")) {
        return Response.json({
          ok: true,
          result: [{
            update_id: 40,
            callback_query: {
              id: "old-exclude",
              data: "exclude:abc123",
              message: { chat: { id: 123 } },
            },
          }],
        });
      }
      if (url.endsWith("/answerCallbackQuery")) {
        return Response.json(
          { ok: false, description: "query is too old and response timeout expired" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 12 } });
    },
  });

  const savedState = JSON.parse(fs.readFileSync(
    path.join(root, "state/repository-state.json"),
    "utf8",
  ));
  const savedDeals = JSON.parse(fs.readFileSync(
    path.join(root, "docs/data/deals.json"),
    "utf8",
  ));
  const savedStatus = JSON.parse(fs.readFileSync(
    path.join(root, "docs/data/status.json"),
    "utf8",
  ));
  const savedExclusions = JSON.parse(fs.readFileSync(
    path.join(root, "config/excluded-hotels.json"),
    "utf8",
  ));

  assert.equal(result.reason, "no_alerts");
  assert.equal(savedExclusions.hotels.length, 1);
  assert.deepEqual(savedDeals.deals, []);
  assert.deepEqual(savedStatus.alerts, []);
  assert.deepEqual(savedState.monitors.madrid.offers, {});
  assert.equal(savedState.telegram.updateError, "");
});

test("advances past an expired callback and continues with newer commands", async () => {
  const state = await processTelegramUpdates({
    telegramState: { updateOffset: 0, mutedMonitorIds: [] },
    token: "secret",
    chatId: "123",
    status: {
      updatedAt: "2026-08-20T12:00:00.000Z",
      summary: {},
      monitors: {
        sesimbra: { monitorName: "Sesimbra", sources: {} },
      },
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/getUpdates")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 20,
                callback_query: {
                  id: "expired",
                  data: "mute:sesimbra",
                  message: { chat: { id: 123 } },
                },
              },
              {
                update_id: 21,
                message: { chat: { id: 123 }, text: "/estado" },
              },
            ],
          }),
        };
      }
      if (url.endsWith("/answerCallbackQuery")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, description: "query is too old" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 9 } }),
      };
    },
  });
  assert.equal(state.updateOffset, 22);
  assert.deepEqual(state.mutedMonitorIds, ["sesimbra"]);
  assert.match(state.updateError, /query is too old/);
});
