import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { Box, IconButton } from '@mui/material';
import MinimizeIcon from '@mui/icons-material/Remove';
import CloseIcon from '@mui/icons-material/Close';
import ContactSupportIcon from '@mui/icons-material/ContactSupport';
import theme from '../lib/theme';
import { ipcRenderer } from '../lib/electron-bridge';
import { InquiryForm } from '../InquiryButton';
import '../css/index.css';
import 'source-code-pro/source-code-pro.css';
import 'typeface-varela/index.css';

const controlStyles = { WebkitAppRegion: 'no-drag', p: 0, borderRadius: 0, width: 34, height: '100%' };

function InquiryWindow(): React.JSX.Element {
	return (
		<StyledEngineProvider injectFirst>
			<ThemeProvider theme={theme}>
				<Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
					<Box
						sx={{
							display: 'flex',
							alignItems: 'center',
							height: theme.spacing(3),
							flexShrink: 0,
							backgroundColor: '#1d1a23',
							WebkitAppRegion: 'drag',
						}}
					>
						<Box
							sx={{
								flex: 1,
								display: 'flex',
								alignItems: 'center',
								gap: 0.75,
								pl: 1.25,
								color: 'primary.main',
								fontSize: 13,
							}}
						>
							<ContactSupportIcon sx={{ fontSize: 14 }} />
							問い合わせ
						</Box>
						<IconButton aria-label="最小化" sx={controlStyles} onClick={() => ipcRenderer.send('minimize', 'inquiry')}>
							<MinimizeIcon sx={{ fontSize: 16 }} />
						</IconButton>
						<IconButton aria-label="閉じる" sx={controlStyles} onClick={() => window.close()}>
							<CloseIcon sx={{ fontSize: 16 }} />
						</IconButton>
					</Box>
					<InquiryForm />
				</Box>
			</ThemeProvider>
		</StyledEngineProvider>
	);
}

createRoot(document.getElementById('app')!).render(<InquiryWindow />);
