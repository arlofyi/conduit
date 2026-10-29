/**
 * The system's Reduce Motion setting, read ONCE for the whole app. Every animated element (a
 * bubble arriving, each avatar's pulse, the typing dots) used to ask the OS itself and hold its
 * own listener — one per row of a long list.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

const Ctx = createContext(false);

export function ReduceMotionProvider({ children }: { children: React.ReactNode }) {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduce(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return <Ctx.Provider value={reduce}>{children}</Ctx.Provider>;
}

export function useReduceMotion(): boolean {
  return useContext(Ctx);
}
