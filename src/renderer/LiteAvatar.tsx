import React from 'react';
import Box from '@mui/material/Box';
import MicOff from '@mui/icons-material/MicOff';
import VolumeOff from '@mui/icons-material/VolumeOff';
import WifiOff from '@mui/icons-material/WifiOff';
import LinkOff from '@mui/icons-material/LinkOff';
import ErrorOutline from '@mui/icons-material/ErrorOutlineOutlined';
// @ts-ignore
import RadioSVG from '../../static/radio.svg';
// @ts-ignore
import liteCrewmateImage from '../../static/images/lite/crew.png';
// @ts-ignore
import liteVisorImage from '../../static/images/lite/visor.png';
import { Player } from '../common/AmongUsState';
import { SocketConfig } from '../common/ISettings';
import { ModsType } from '../common/Mods';

const defaultPlayerColors = [
	['#C51111', '#7A0838'],
	['#132ED1', '#09158E'],
	['#117F2D', '#0A4D2E'],
	['#ED54BA', '#AB2BAD'],
	['#EF7D0D', '#B33E15'],
	['#F5F557', '#C38823'],
	['#3F474E', '#1E1F26'],
	['#FFFFFF', '#8394BF'],
	['#6B2FBB', '#3B177C'],
	['#71491E', '#5E2615'],
	['#38FEDC', '#24A8BE'],
	['#50EF39', '#15A742'],
];

const useStyles = () => ({
	relative: {
		position: 'relative',
	},
	icon: {
		background: '#ea3c2a',
		position: 'absolute',
		left: '50%',
		top: '50%',
		transform: 'translate(-50%, -50%)',
		border: '2px solid #690a00',
		borderRadius: '50%',
		padding: '2px',
		zIndex: 10,
	},
	radio: {
		position: 'absolute',
		left: '70%',
		top: '80%',
		width: '30px',
		transform: 'translate(-50%, -50%)',
		fill: 'white',
		padding: '2px',
		zIndex: 12,
	},
});

export interface LiteAvatarProps {
	talking: boolean;
	borderColor: string;
	isAlive: boolean;
	player: Player;
	size: number;
	deafened?: boolean;
	muted?: boolean;
	connectionState?: 'disconnected' | 'novoice' | 'connected';
	socketConfig?: SocketConfig;
	showborder?: boolean;
	showHat?: boolean;
	lookLeft?: boolean;
	overflow?: boolean;
	isUsingRadio?: boolean;
	onConfigChange?: () => void;
	mod: ModsType;
	colorPalette?: string[];
}

const LiteAvatar: React.FC<LiteAvatarProps> = function ({
	talking,
	deafened,
	muted,
	borderColor,
	isAlive,
	player,
	size,
	connectionState,
	socketConfig,
	showborder,
	isUsingRadio,
	lookLeft = false,
	onConfigChange,
	colorPalette,
}: LiteAvatarProps) {
	const classes = useStyles();
	let icon;
	const hasDisplayOutfit = player.currentOutfit > 0 && player.currentOutfit <= 10;
	const displayColor = hasDisplayOutfit && player.appearanceColorId >= 0 ? player.appearanceColorId : player.colorId;
	const liteColor = colorPalette?.[0] || defaultPlayerColors[displayColor]?.[0] || '#6b7280';
	const liteBorderColor = talking ? borderColor : showborder === true ? '#ccbdcc86' : 'transparent';
	deafened = deafened === true || socketConfig?.isMuted === true || socketConfig?.volume === 0;

	switch (connectionState) {
		case 'connected':
			if (deafened) {
				icon = <VolumeOff sx={classes.icon} />;
			} else if (muted) {
				icon = <MicOff sx={classes.icon} />;
			}
			break;
		case 'novoice':
			icon = <LinkOff sx={classes.icon} style={{ background: '#e67e22', borderColor: '#694900' }} />;
			break;
		case 'disconnected':
			icon = <WifiOff sx={classes.icon} />;
			break;
	}
	if (player.bugged) {
		icon = <ErrorOutline sx={classes.icon} style={{ background: 'red', borderColor: '' }} />;
	}

	return (
		<Box sx={classes.relative}>
			<Box
				sx={classes.relative}
				onClick={onConfigChange}
				style={{
					width: '100%',
					paddingBottom: '100%',
					borderRadius: '50%',
					borderStyle: 'solid',
					borderWidth: Math.max(2, size / 40),
					borderColor: liteBorderColor,
					boxSizing: 'border-box',
					transition: 'border-color .2s ease-out, box-shadow .2s ease-out',
					boxShadow: talking ? `0 0 ${Math.max(6, Math.round(size / 10))}px ${borderColor}` : 'none',
					opacity: isAlive ? 1 : 0.45,
					cursor: 'pointer',
					transform: lookLeft ? 'scaleX(-1)' : 'scaleX(1)',
				}}
			>
				<Box
					style={{
						position: 'absolute',
						left: '17%',
						bottom: '2%',
						width: '67%',
						height: '13%',
						borderRadius: '50%',
						background: 'rgba(0, 0, 0, 0.32)',
					}}
				/>
				<Box
					style={{
						position: 'absolute',
						left: '9%',
						top: 0,
						width: '81%',
						height: '100%',
						filter: 'drop-shadow(0 2px 2px rgba(0, 0, 0, 0.35))',
					}}
				>
					<Box
						style={{
							position: 'absolute',
							inset: 0,
							background: liteColor,
							WebkitMaskImage: `url(${liteCrewmateImage})`,
							maskImage: `url(${liteCrewmateImage})`,
							WebkitMaskRepeat: 'no-repeat',
							maskRepeat: 'no-repeat',
							WebkitMaskSize: 'contain',
							maskSize: 'contain',
							WebkitMaskPosition: 'center',
							maskPosition: 'center',
						}}
					/>
					<img
						src={liteCrewmateImage}
						alt=""
						style={{
							position: 'absolute',
							inset: 0,
							width: '100%',
							height: '100%',
							objectFit: 'contain',
							mixBlendMode: 'multiply',
							opacity: 0.72,
							pointerEvents: 'none',
						}}
					/>
					<img
						src={liteVisorImage}
						alt=""
						style={{
							position: 'absolute',
							inset: 0,
							width: '100%',
							height: '100%',
							objectFit: 'contain',
							pointerEvents: 'none',
						}}
					/>
				</Box>
				{isUsingRadio && <Box component="img" src={RadioSVG} sx={classes.radio} />}
			</Box>
			{icon}
		</Box>
	);
};

export default LiteAvatar;
