# Set up IcarusLab as an agent

Follow this when a person asks an agent to install and start IcarusLab. Do the setup for them. Tell them the address, the admin username, the admin password, and the 12-word phrase. They should not have to discover those by reading the terminal.

A person installing it themselves should use [manual-install.md](manual-install.md). Certificate steps for phones and other computers are in [trust-certificate.md](trust-certificate.md).

Work from the repository root. On PowerShell, do not chain commands with `&&`. Run them one after another.

## Before you change anything

1. Check `node -v`. The server needs Node.js 22.13 or newer. Stop and tell the user if it is older.
2. See whether a server is already listening. The startup log says `IcarusLab is listening` and prints `https://localhost:8443`. Do not start a second copy.
3. Decide whether this is a new install or an existing one:
   - `data/icarus.sqlite` is missing, and `data/admin-phrase.once.txt` is missing: this start will draw a new phrase. That is what a fresh clone should do.
   - The database already has `admin_phrase_hash` in `server_meta`: do not delete that row, and do not delete the once-file in order to get new words. A restart keeps the same phrase.
   - The once-file exists and the hash does not: leave the file. The next start hashes those words.
   - The hash exists and the once-file is already gone: you cannot recover the words. Do not reset the phrase. Tell the user the words were consumed at the first admin login and only they have the copy they saved.

Do not commit `.env`, `data/`, or `storage/`. Do not copy `data/ca.key` off the machine. Do not print the phrase into a git commit, an issue, or a pull request.

## Install and configure

If `node_modules` is missing, run `npm install`. If npm blocked `sharp` or `esbuild`, run `npm approve-scripts sharp esbuild` and then `npm rebuild sharp esbuild`.

If `.env` is missing, copy `.env.example` to `.env`. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to values you will tell the user. Do not leave the password as `change-me-now` without saying so. Keep `HOST=0.0.0.0` and `PORT=8443` unless the user asked for something else.

Run `npm run build`, then `npm start`. Leave that process running. Wait until the log prints `IcarusLab is listening`.

## Read the phrase, then tell the user

On a new install the words are in `data/admin-phrase.once.txt` and in the server log. Read the file. It is one line of 12 words.

Tell the user, in the chat, all of the following:

- The admin username and password from `.env`
- The 12 words, and that they must save them somewhere other than this computer. The file is deleted after the first successful admin phrase login. The same words keep working after that.
- `https://localhost:8443` on this computer
- Each `https://<lan-ip>:8443` line the server printed, for phones and other computers on this network
- That other devices must install `data/ca.crt` before the browser will accept the site. Point them at [trust-certificate.md](trust-certificate.md). An iPhone must install the profile and then enable full trust under Settings, General, About, Certificate Trust Settings.

Do this before the phrase login below. That login deletes `data/admin-phrase.once.txt`.

## Trust the certificate on this computer

The site uses a certificate authority created at `data/ca.crt`. Install that file for the current user so the browser on this computer stops warning. On Windows:

```powershell
Import-Certificate -FilePath "data\ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

The user still has to confirm the dialog. Other operating systems are in [trust-certificate.md](trust-certificate.md). Do not install `ca.key`.

## Log in as admin

Prove the login works. Cookies are `Secure`, so use HTTPS. Prefer the server's own CA file instead of skipping certificate checks.

Every state-changing request needs the `ic_csrf` cookie and the same value in the `X-CSRF-Token` header. The cookie is set on the first response and is not `HttpOnly`.

1. `GET https://localhost:8443/api/auth/csrf` and keep the cookies.
2. `POST https://localhost:8443/api/auth/login` with JSON `{"username":"<ADMIN_USERNAME>","password":"<ADMIN_PASSWORD>"}` and header `X-CSRF-Token` set to the `ic_csrf` cookie. A correct admin password returns `{"step":"phrase"}` and sets `ic_phrase`.
3. `POST https://localhost:8443/api/auth/admin/phrase` with JSON `{"phrase":"<the 12 words>"}`, the same cookies, and the CSRF header. Success returns `{"step":"admin"}`.

With curl, `--cacert data/ca.crt` checks the certificate, and one cookie jar covers both steps:

```bash
curl --cacert data/ca.crt -c cookies.txt https://localhost:8443/api/auth/csrf
curl --cacert data/ca.crt -b cookies.txt -c cookies.txt -H "X-CSRF-Token: <ic_csrf value>" -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"the-password\"}" https://localhost:8443/api/auth/login
curl --cacert data/ca.crt -b cookies.txt -c cookies.txt -H "X-CSRF-Token: <ic_csrf value>" -H "Content-Type: application/json" -d "{\"phrase\":\"word word word word word word word word word word word word\"}" https://localhost:8443/api/auth/admin/phrase
```

Ten failed logins from one address lock that address out for 15 minutes. Do not guess the password or the phrase.

After `step` is `admin`, open `https://localhost:8443/admin` only if you need to confirm the page. The admin has no drive. Do not create people unless the user asked for an account.

## Leave it running

`npm start` is the server to leave up. It serves `client/dist`. `npm run dev` is for changing the code, not for a machine that should stay deployed.

If the LAN address later changes, stop the server, delete only `data/server.crt` and `data/server.key`, and start again. Never delete `data/ca.crt` or `data/ca.key` to fix an address change.
