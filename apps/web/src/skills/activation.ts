/** Selected IDs are input preparation only; activation and dependency checks run
 * with the server task's frozen skill/MCP scope. Legacy pins do not activate. */
export const explicitSkillIds = (turn: number[] = []) => [...new Set(turn)];
