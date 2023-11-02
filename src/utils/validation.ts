export function validateAndReturnData(objList: any, ttl: number = 5000): any {
  for (const obj of objList) {
    if (obj === undefined) {
      throw new Error("[Validation Fail] Undefined Object");
    } else if (obj.timestamp + ttl < new Date().getTime()) {
      throw new Error(
        `[Validation Fail] Expired Data.\nNow: ${new Date().toISOString()}\nObj: ${new Date(
          obj.timestamp
        ).toISOString()}\nOBJ: ${JSON.stringify(obj, null, 2)}`
      );
    }
  }
  return objList;
}

export function validateActionParams() {
  return;
}
