export interface MegaphoneState {
	playerId: number;
	energy: number;
	range: number;
	voiceEffect?: boolean;
	shotId?: number;
	phase?: 'charging' | 'firing';
}
