import { createContext, useContext } from 'react';
import type { PowerFlowDescriptor } from '../model/types';

/**
 * Power-flow overlay of the topology canvas. Read at render time from the
 * latest snapshot: analysis results replace the snapshot but keep the laid-out
 * nodes and edges, so the values must not live in node or edge data.
 */
export const PowerFlowContext = createContext<{
  powerFlow?: PowerFlowDescriptor;
  visible: boolean;
}>({ visible: false });

/** The power flow to draw, or undefined when hidden or unavailable. */
export function usePowerFlow(): PowerFlowDescriptor | undefined {
  const { powerFlow, visible } = useContext(PowerFlowContext);
  return visible && powerFlow?.available ? powerFlow : undefined;
}

export function formatPQ(P: number, Q: number): string {
  return `P ${P.toFixed(3)}  Q ${Q.toFixed(3)}`;
}
