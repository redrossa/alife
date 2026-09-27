/** A readable message for anything thrown; abort reasons and rejections need not be `Error`s. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
