import { shell } from '../lib/electron-bridge';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { Tooltip } from '@mui/material';
import InquiryButton from '../InquiryButton';

const useStyles = () => ({
	footer: {
		position: 'absolute',
		bottom: 0,
		width: '100%',
		display: 'flex',
		flexDirection: 'column',
		justifyContent: 'center',
		alignItems: 'center',
	},
	row: {
		width: '100%',
		display: 'flex',
		justifyContent: 'space-evenly',
		margin: '5px',
		'& .MuiButton-root': {
			minWidth: 0,
			padding: '6px',
		},
	},
});

const RawFooter: React.FC = function () {
	const classes = useStyles();
	return (
		<Box sx={classes.footer}>
			<Box sx={classes.row}>
				<Button
					color="grey"
					onClick={() => {
						shell.openExternal('https://github.com/kuretoshi/BetterCrewLink/tree/voice_fixed');
					}}
				>
					<Tooltip title="GitHubのページはこちら" arrow>
						<svg width={36} height={36} viewBox="0 0 24 24" color="White">
							<path
								fill="currentColor"
								d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10 0 0,0 12,2Z"
							/>
						</svg>
					</Tooltip>
				</Button>
				<Button
					color="grey"
					onClick={() => {
						shell.openExternal('https://discord.gg/jEyDrpBsmJ');
					}}
				>
					<Tooltip title="サポート用のDiscordに参加" arrow>
						<svg viewBox="0 0 245 240" width={36} height={36}>
							<path
								fill="#7289DA"
								d="M104.4 103.9c-5.7 0-10.2 5-10.2 11.1s4.6 11.1 10.2 11.1c5.7 0 10.2-5 10.2-11.1.1-6.1-4.5-11.1-10.2-11.1zM140.9 103.9c-5.7 0-10.2 5-10.2 11.1s4.6 11.1 10.2 11.1c5.7 0 10.2-5 10.2-11.1s-4.5-11.1-10.2-11.1z"
							/>
							<path
								fill="#7289DA"
								d="M189.5 20h-134C44.2 20 35 29.2 35 40.6v135.2c0 11.4 9.2 20.6 20.5 20.6h113.4l-5.3-18.5 12.8 11.9 12.1 11.2 21.5 19V40.6c0-11.4-9.2-20.6-20.5-20.6zm-38.6 130.6s-3.6-4.3-6.6-8.1c13.1-3.7 18.1-11.9 18.1-11.9-4.1 2.7-8 4.6-11.5 5.9-5 2.1-9.8 3.5-14.5 4.3-9.6 1.8-18.4 1.3-25.9-.1-5.7-1.1-10.6-2.7-14.7-4.3-2.3-.9-4.8-2-7.3-3.4-.3-.2-.6-.3-.9-.5-.2-.1-.3-.2-.4-.3-1.8-1-2.8-1.7-2.8-1.7s4.8 8 17.5 11.8c-3 3.8-6.7 8.3-6.7 8.3-22.1-.7-30.5-15.2-30.5-15.2 0-32.2 14.4-58.3 14.4-58.3 14.4-10.8 28.1-10.5 28.1-10.5l1 1.2c-18 5.2-26.3 13.1-26.3 13.1s2.2-1.2 5.9-2.9c10.7-4.7 19.2-6 22.7-6.3.6-.1 1.1-.2 1.7-.2 6.1-.8 13-1 20.2-.2 9.5 1.1 19.7 3.9 30.1 9.6 0 0-7.9-7.5-24.9-12.7l1.4-1.6s13.7-.3 28.1 10.5c0 0 14.4 26.1 14.4 58.3 0 0-8.5 14.5-30.6 15.2z"
							/>
						</svg>
					</Tooltip>
				</Button>
				<Button
					color="grey"
					aria-label="支援する（Ko-fi）"
					onClick={() => shell.openExternal('https://ko-fi.com/kuretoshi')}
				>
					<Tooltip title="お賽銭で開発を支援する" arrow>
						<svg width={36} height={36} viewBox="0 0 48 48" role="img" aria-hidden="true">
							<circle cx="24" cy="7" r="5" fill="#f6d46b" stroke="#5b371f" strokeWidth="1.5" />
							<path d="M24 4v6m-2-4h4m-4 2h4" stroke="#5b371f" strokeWidth="1.2" strokeLinecap="round" />
							<path
								d="M7 18l6-5h28l3 5-4 5H11z"
								fill="#b77b45"
								stroke="#f4d5a0"
								strokeWidth="2"
								strokeLinejoin="round"
							/>
							<path d="M7 18h37M13 13l-2 10m10-10-1 10m9-10 1 10m10-10 4 10" stroke="#5b371f" strokeWidth="2" />
							<path d="M10 23h31v19H10z" fill="#8b562f" stroke="#f4d5a0" strokeWidth="2" />
							<path d="M16 26v13m8-13v13m8-13v13" stroke="#ba8654" strokeWidth="2" />
							<path d="M20 19h10" stroke="#38241a" strokeWidth="2.5" strokeLinecap="round" />
						</svg>
					</Tooltip>
				</Button>
				<Button color="grey" aria-label="X" onClick={() => shell.openExternal('https://x.com/tanukibcl?s=11')}>
					<Tooltip title="Xのページはこちら" arrow>
						<svg width={36} height={36} viewBox="0 0 1200 1227" role="img" aria-hidden="true">
							<path
								d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z"
								fill="white"
							/>
						</svg>
					</Tooltip>
				</Button>
				<InquiryButton />
			</Box>
		</Box>
	);
};

const Footer = React.memo(RawFooter);

export default Footer;
