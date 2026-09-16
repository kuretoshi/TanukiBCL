import React from 'react';
import { Box, Tooltip } from '@mui/material';
import { ConnectionQuality, qualityBars } from '../voice/connectionQuality';

export default function ConnectionIndicator({
	quality,
	connected,
}: {
	quality?: ConnectionQuality;
	connected: boolean;
}) {
	const bars = connected ? qualityBars(quality) : 0;
	const status = !connected ? '未接続' : bars === 0 ? '未計測' : ['', '不安定', '普通', '良好'][bars];
	const ping = connected && quality?.rttMs != null ? `${Math.round(quality.rttMs)} ms` : '—';
	const label = `音声接続：${status}／自分との往復遅延（ping）：${ping}`;
	return (
		<Tooltip
			arrow
			title={
				<Box>
					<div>音声接続：{status}</div>
					<div>自分との往復遅延（ping）：{ping}</div>
					{connected && quality?.jitterMs != null && <div>受信の揺らぎ：{Math.round(quality.jitterMs)} ms</div>}
					{connected && quality?.lossPercent != null && <div>受信ロス：{quality.lossPercent.toFixed(1)}%</div>}
				</Box>
			}
		>
			<Box
				component="span"
				tabIndex={0}
				role="img"
				aria-label={label}
				sx={{
					position: 'absolute',
					right: -2,
					bottom: -2,
					zIndex: 11,
					display: 'flex',
					alignItems: 'flex-end',
					gap: '2px',
					p: '3px',
					borderRadius: '4px',
					bgcolor: '#202428',
					cursor: 'help',
				}}
			>
				{[1, 2, 3].map((bar) => (
					<Box
						key={bar}
						component="span"
						sx={{
							width: 3,
							height: 3 + bar * 3,
							borderRadius: '1px',
							bgcolor: bar <= bars ? ['', '#ef5350', '#ffca28', '#66bb6a'][bars] : '#72777d',
						}}
					/>
				))}
			</Box>
		</Tooltip>
	);
}
