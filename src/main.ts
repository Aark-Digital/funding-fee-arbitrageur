import { sleep } from "./utils/time";

require("dotenv").config();

async function main() {
  const {
    strategy,
    initializeStrategy,
  } = require(`./strategies/${process.env.STRATEGY}.ts`);

  await initializeStrategy();

  while (true) {
    try {
      console.log(`~~~~~~~ ${new Date().toISOString()} ~~~~~~~`);
      strategy();
    } catch (e) {
      console.log(e);
    }
    await sleep(5000);
  }
}

main().then(() => console.log("Done"));
