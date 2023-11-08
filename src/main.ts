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
