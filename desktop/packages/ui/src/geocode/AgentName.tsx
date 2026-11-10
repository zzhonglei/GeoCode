import { agentLabel } from '@/lib/agentLabel';
import { useConfigStore } from '@/stores/useConfigStore';

/** The name the agent picker shows for an agent id, such as GeoAgent for `geoagent`; the id while the agent is unknown. */
export function AgentName({ id }: { id: string }) {
  const agent = useConfigStore((state) => state.agents.find((entry) => entry.name === id));
  return <>{agent ? agentLabel(agent) : id}</>;
}
