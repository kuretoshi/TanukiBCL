export const vcRuntimeDownloadPage = 'https://learn.microsoft.com/ja-jp/cpp/windows/latest-supported-vc-redist';
export const sharedSpeechInstaller =
	'https://github.com/kuretoshi/TanukiBCL/releases/download/v3.2.69/TanukiBCL-SharedSpeech-Setup-2.0.2.1.exe';
export interface SharedSpeechStatus {
	runtimeInstalled: boolean;
	modelAvailable: boolean;
	available: boolean;
	enabled: boolean;
	error: string;
}
export function speechSetupDownloadUrl(status: Pick<SharedSpeechStatus, 'runtimeInstalled'>): string {
	return status.runtimeInstalled ? sharedSpeechInstaller : vcRuntimeDownloadPage;
}
