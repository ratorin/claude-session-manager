#!/usr/bin/env python
"""Open VSXに公開するスクリプト（トークンを暗号ファイルから取得）"""
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64, json, os, subprocess, glob

ENC_FILE = 'c:/xampp/openvsx_token.enc'

if not os.path.exists(ENC_FILE):
	print(f"暗号化ファイルが見つかりません: {ENC_FILE}")
	print("先に python c:\\xampp\\encrypt_credentials.py でトークンを保存してください")
	exit(1)

# 最新のvsixファイルを取得
vsix_files = sorted(glob.glob('*.vsix'), key=os.path.getmtime, reverse=True)
if not vsix_files:
	print("vsixファイルが見つかりません。npx @vscode/vsce package を先に実行してください")
	exit(1)

vsix = vsix_files[0]
print(f"公開対象: {vsix}")

passphrase = input("パスフレーズを入力: ").encode('utf-8')

# 復号
with open(ENC_FILE, 'rb') as f:
	raw = f.read()
salt_b64, encrypted = raw.split(b'::')
salt = base64.b64decode(salt_b64)
kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=480000)
key = base64.urlsafe_b64encode(kdf.derive(passphrase))
fernet = Fernet(key)
data = json.loads(fernet.decrypt(encrypted).decode('utf-8'))
token = data['token']

# 公開
result = subprocess.run(['npx', 'ovsx', 'publish', vsix, '-p', token], shell=True)
exit(result.returncode)
