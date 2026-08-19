/** Convert renderer-level context failures into CLI failures with exit code 1. */
export function requireSuccessfulContext(result: any): any {
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(String(result.error || '无法解析当前 AI 身份与能力'));
  }
  return result;
}
