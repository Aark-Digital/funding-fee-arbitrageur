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

  const strategyPeriodMs = Number(process.env.STRATEGY_PERIOD_MS);
  if (Number.isNaN(strategyPeriodMs)) {
    throw new Error("Undefined Strategy periods");
  }
  const { Strategy } = require(`./strategies/${process.env.STRATEGY_NAME}`);

  const strategy = new Strategy();
  await strategy.init();

  while (true) {
    try {
      console.log(`~~~~~~~ ${new Date().toISOString()} ~~~~~~~`);
      await strategy.run();
    } catch (e) {
      console.log(e);
    }
    await sleep(strategyPeriodMs);
  }
}

main().then(() => console.log("Done"));
