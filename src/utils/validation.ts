export function validateAndReturnData(objList: any, ttl: number): any {
  for (const obj of objList) {
    if (obj === undefined) {
      throw new Error("[Validation Fail] Undeinfed Object");
    } else if (obj.timestamp + ttl < new Date().getTime()) {
      throw new Error(
        `[Validation Fail] Expired Data.\nNow: ${new Date().toISOString()}\nObj: ${new Date(
          obj.timestamp
        ).toISOString()}`
      );
    }
  }
  return objList;
}

export function validateActionParams() {
  return;
}
