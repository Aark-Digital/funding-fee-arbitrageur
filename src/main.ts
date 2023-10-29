import { sleep } from "./utils/time";

require("dotenv").config();

async function main() {
  const { strategy } = require(`./strategies/${process.env.STRATEGY}.ts`);

  while (true) {
    try {
      strategy();
    } catch (e) {
      console.log(e);
    }
    await sleep(5000);
  }
}

main().then(() => console.log("Done"));
