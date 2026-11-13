/** The words of a failure, whatever was thrown: an Error, an error-like object, or anything else. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}
