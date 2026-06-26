import React, { useState } from 'react';
import { ipcRenderer } from 'electron';
import {
	Alert,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	MenuItem,
	Select,
	TextField,
	Tooltip,
	Typography,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import ContactSupportIcon from '@mui/icons-material/ContactSupport';
import DeleteIcon from '@mui/icons-material/Delete';
import SendIcon from '@mui/icons-material/Send';
import { InquiryAttachment, InquiryTag, IpcHandlerMessages } from '../common/ipc-messages';

const TEXT = {
	attachmentSelect: '\u6dfb\u4ed8\u30d5\u30a1\u30a4\u30eb\u3092\u9078\u629e',
	body: '\u672c\u6587',
	cancel: '\u30ad\u30e3\u30f3\u30bb\u30eb',
	inquiry: '\u554f\u3044\u5408\u308f\u305b',
	send: '\u9001\u4fe1',
	sendComplete:
		'\u9001\u4fe1\u3057\u307e\u3057\u305f\u3002\u304a\u554f\u3044\u5408\u308f\u305b\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3059\u3002',
	subject: '\u4ef6\u540d',
	tag: '\u7a2e\u5225',
	tagBug: '\u4e0d\u5177\u5408',
	tagQuestion: '\u8cea\u554f',
	tagRequest: '\u8981\u671b',
	tooltip: '\u554f\u3044\u5408\u308f\u305b\u3092\u9001\u4fe1',
};

const useStyles = makeStyles((theme) => ({
	form: {
		display: 'flex',
		flexDirection: 'column',
		gap: theme.spacing(2),
		paddingTop: theme.spacing(1),
	},
	attachmentRow: {
		display: 'flex',
		alignItems: 'center',
		gap: theme.spacing(1),
		minHeight: 32,
	},
	attachmentName: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	icon: {
		marginRight: theme.spacing(1),
	},
}));

const InquiryButton: React.FC = function () {
	const classes = useStyles();
	const [open, setOpen] = useState(false);
	const [subject, setSubject] = useState('');
	const [body, setBody] = useState('');
	const [tag, setTag] = useState<InquiryTag>('question');
	const [attachments, setAttachments] = useState<InquiryAttachment[]>([]);
	const [sending, setSending] = useState(false);
	const [message, setMessage] = useState('');
	const [error, setError] = useState('');

	const resetStatus = () => {
		setMessage('');
		setError('');
	};

	const selectAttachments = async () => {
		resetStatus();
		try {
			const selected = (await ipcRenderer.invoke(IpcHandlerMessages.SELECT_INQUIRY_ATTACHMENTS)) as InquiryAttachment[];
			if (selected.length > 0) {
				const paths = new Set(attachments.map((attachment) => attachment.path));
				setAttachments([...attachments, ...selected.filter((attachment) => !paths.has(attachment.path))]);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const submitInquiry = async () => {
		resetStatus();
		setSending(true);
		try {
			await ipcRenderer.invoke(IpcHandlerMessages.SUBMIT_INQUIRY, {
				subject,
				body,
				tag,
				attachmentPaths: attachments.map((attachment) => attachment.path),
			});
			setMessage(TEXT.sendComplete);
			setSubject('');
			setBody('');
			setTag('question');
			setAttachments([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	return (
		<>
			<Button color="grey" onClick={() => setOpen(true)}>
				<Tooltip title={TEXT.tooltip} arrow>
					<ContactSupportIcon htmlColor="white" fontSize="large" />
				</Tooltip>
			</Button>
			<Dialog fullWidth maxWidth="sm" open={open} onClose={() => !sending && setOpen(false)}>
				<DialogTitle>{TEXT.inquiry}</DialogTitle>
				<DialogContent>
					<div className={classes.form}>
						{message && <Alert severity="success">{message}</Alert>}
						{error && <Alert severity="error">{error}</Alert>}
						<Select
							value={tag}
							onChange={(event) => setTag(event.target.value as InquiryTag)}
							disabled={sending}
							fullWidth
							displayEmpty
						>
							<MenuItem value="question">{TEXT.tagQuestion}</MenuItem>
							<MenuItem value="bug">{TEXT.tagBug}</MenuItem>
							<MenuItem value="request">{TEXT.tagRequest}</MenuItem>
						</Select>
						<TextField
							label={TEXT.subject}
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
							disabled={sending}
							fullWidth
							required
							inputProps={{ maxLength: 100 }}
						/>
						<TextField
							label={TEXT.body}
							value={body}
							onChange={(event) => setBody(event.target.value)}
							disabled={sending}
							fullWidth
							required
							multiline
							minRows={6}
							inputProps={{ maxLength: 1800 }}
						/>
						<div>
							<Button variant="outlined" color="secondary" onClick={selectAttachments} disabled={sending}>
								<AttachFileIcon className={classes.icon} />
								{TEXT.attachmentSelect}
							</Button>
							{attachments.map((attachment) => (
								<div className={classes.attachmentRow} key={attachment.path}>
									<Typography className={classes.attachmentName}>{attachment.name}</Typography>
									<IconButton
										size="small"
										disabled={sending}
										onClick={() => setAttachments(attachments.filter((current) => current.path !== attachment.path))}
									>
										<DeleteIcon fontSize="small" />
									</IconButton>
								</div>
							))}
						</div>
					</div>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setOpen(false)} disabled={sending}>
						{TEXT.cancel}
					</Button>
					<Button
						variant="contained"
						color="secondary"
						onClick={submitInquiry}
						disabled={sending || subject.trim().length === 0 || body.trim().length === 0}
					>
						<SendIcon className={classes.icon} />
						{TEXT.send}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
};

export default InquiryButton;
