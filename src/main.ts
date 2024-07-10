import { MonitorService } from "./services/monitor.service";
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
  } else if (
    process.env.SLACK_URL === undefined ||
    process.env.TWILIO_PARAM === undefined ||
    process.env.MANAGER_PARAM === undefined
  ) {
    throw Error("Undefined Params for Monitoring");
  }
  const monitorService = MonitorService.getInstance();
  const { Strategy } = require(`./strategies/${process.env.STRATEGY_NAME}`);

  const strategy = new Strategy();

  await strategy.init();

  let errCnt = 0;

  while (true) {
    try {
      console.log(`~~~~~~~ ${new Date().toISOString()} ~~~~~~~`);
      await strategy.run();
      errCnt = 0;
    } catch (e) {
      console.log(e);
      errCnt += 1;
      if (errCnt > 10) {
        monitorService.slackMessage(
          "CONSECUTIVE LOGIC ERROR",
          `Error occured for ${errCnt} times : ${e}`,
          60_000,
          true,
          true
        );
      }
    }
    await sleep(strategyPeriodMs);
  }
}

main().then(() => console.log("Done"));
