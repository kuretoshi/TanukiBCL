const form = document.getElementById('registration');
const result = document.getElementById('result');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = '';
  const password = document.getElementById('password').value;
  if (password !== document.getElementById('confirmation').value) {
    result.textContent = 'パスワードが一致していません。';
    return;
  }
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    result.textContent = '管理者から案内されたHTTPSの登録ページを開いてください。';
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/v1/debug-auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('code').value.trim(), password }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (response.ok && data.registered === true) {
      form.reset();
      form.hidden = true;
      result.textContent = '登録が完了しました。ベタクルのデバッグ画面で、設定したパスワードを入力してください。';
    } else {
      result.textContent = data.error || '登録できませんでした。管理者に確認してください。';
    }
  } catch {
    result.textContent = '通信に失敗しました。登録済みの可能性があります。再試行で使用済みと出る場合は、ベタクルでパスワードを確認してください。';
  } finally {
    button.disabled = false;
  }
});
