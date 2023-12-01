export function isValidData(objList: any, ttl: number = 5000): any {
  for (const obj of objList) {
    if (obj === undefined) {
      return false;
    } else if (obj.timestamp + ttl < new Date().getTime()) {
      return false;
    }
  }
  return true;
}
