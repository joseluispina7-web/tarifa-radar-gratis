const fs = require("node:fs");
const path = require("node:path");
const { scrapeBooking } = require("./booking-scraper.cjs");
const { compareWithState } = require("./state.cjs");

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--config") args.config = argv[++index];
    if (item === "--output") args.output = argv[++index];
    if (item === "--state") args.state = argv[++index];
    if (item === "--headed") args.headed = true;
    if (item === "--summary") args.summary = true;
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.config) {
    throw new Error("Uso: node src/cli.cjs --config config/busqueda.json");
  }

  const configPath = path.resolve(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const result = await scrapeBooking(config, { headless: !args.headed });
  if (args.state) {
    const statePath = path.resolve(args.state);
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      previous = {};
    }
    const comparison = compareWithState(previous, result);
    result.changes = comparison.changes;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(comparison.state, null, 2)}\n`,
      "utf8",
    );
  }

  const payload = JSON.stringify(result, null, 2);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${payload}\n`, "utf8");
  }
  if (args.summary) {
    process.stdout.write(`${JSON.stringify({
      source: result.source,
      searchedAt: result.searchedAt,
      destination: result.search.destinationLabel,
      dates: `${result.search.checkIn} / ${result.search.checkOut}`,
      offers: result.offers.length,
      matches: result.matchingOffers.length,
      changes: result.changes?.length || 0,
      cheapestMatch: result.matchingOffers[0]
        ? {
            hotelName: result.matchingOffers[0].hotelName,
            totalPrice: result.matchingOffers[0].totalPrice,
            nightlyPrice: result.matchingOffers[0].nightlyPrice,
          }
        : null,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
