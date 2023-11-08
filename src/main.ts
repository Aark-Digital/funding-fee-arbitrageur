import { sleep } from "./utils/time";

require("dotenv").config();

async function main() {
  const express = require("express");
  const healthCheckApp = express();
  const port = 3000;

  healthCheckApp.get("/", (req: any, res: any) => {
    res.send("HEALTHY");
  });

  healthCheckApp.listen(port, () => {
    console.log(`Health check app listening on port ${port}`);
  });

  console.log(
    process.env.PRICE_URL!,
    process.env.OCT_BACKEND_URL!,
    process.env.AARK_INDEX_PRICE_URL!
  );

  const {
    strategy,
    initializeStrategy,
  } = require(`./strategies/${process.env.STRATEGY}`);

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
