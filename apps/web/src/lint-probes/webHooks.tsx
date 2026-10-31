import { useState } from "react";
export function A({ on }: { on: boolean }) {
  if (on) useState(0);
  return null;
}
