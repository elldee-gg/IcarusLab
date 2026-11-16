# Install IcarusLab yourself

Use this when you are setting the server up by hand. If an agent is doing the setup, it should follow [agent-setup.md](agent-setup.md) instead.

IcarusLab is one Node process. It serves the site and the API over HTTPS on port 8443. Other devices on the same network open `https://<server-ip>:8443`.

## What you need

- Node.js 22.13 or newer
- This repository on the computer that will stay on
- A username and password you will put in `.env`

## First start

From the repository folder:

```bash
npm install
```

If the install blocks `sharp` or `esbuild`, allow those two and rebuild them. Thumbnails and the client build need them.

```bash
npm approve-scripts sharp esbuild
npm rebuild sharp esbuild
```

Copy the environment file and edit it. On macOS or Linux, use `cp` instead of `copy`.

```bash
copy .env.example .env
```

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Leave `HOST` as `0.0.0.0` and `PORT` as `8443` unless you have a reason to change them. Then:

```bash
npm run build
npm start
```

The first start creates `data/` and `storage/`. Those folders are not part of the git clone. The terminal prints:

- `https://localhost:8443`
- `https://<lan-ip>:8443` for each network address it found
- A 12-word admin phrase

Save the phrase somewhere other than this computer's disk. The same words keep working after a restart or a power loss. They are also written to `data/admin-phrase.once.txt` until the first successful admin login. After that login the file is removed. The hash in the database stays, so the words still work. A later start does not create a new phrase.

Each new install draws its own phrase. Cloning the repository onto another computer does not copy this computer's words, certificates, database, or files.

Windows may ask whether Node may listen on the network. Allow it on private networks. If another computer cannot connect, allow inbound TCP 8443 in Windows Firewall for Node.

## Trust the certificate

The browser will not accept the site until `data/ca.crt` is installed as a trusted authority. That includes the server itself. The steps for Windows, macOS, Linux, Firefox, iPhone, and Android are in [trust-certificate.md](trust-certificate.md).

Copy `data/ca.crt` to each device. Do not copy `data/ca.key`.

## Sign in

Open `https://localhost:8443` on the server, or the printed LAN address from another device. `/` is the login page.

The admin username and password are the values from `.env`. After those succeed, enter the 12-word phrase. That login opens `/admin`.

Create people there. A new person signs in with the password `password`, then sets a display name and a new password of at least 10 characters. Until that is done, their drive stays locked. Forgot password only notifies the admin. It does not change the password.

## When the LAN address changes

The site certificate is issued for the addresses printed at startup. If that address changes, stop the server, delete `data/server.crt` and `data/server.key`, and start again. Leave `data/ca.crt` and `data/ca.key` in place. Devices that already trust `ca.crt` do not install it again.

## What not to copy to another computer

| File | Where it belongs |
| --- | --- |
| `data/ca.crt` | Copy this to each device that will open the site |
| `data/ca.key` | Server only |
| `data/server.crt` and `data/server.key` | Server only |
| `data/jwt.secret` | Server only |
| `data/admin-phrase.once.txt` | Server only, and only until the first admin login |
| `data/` and `storage/` | This server only. Copying them copies this install's phrase, certificates, and files |
| `.env` | Server only. The admin password is not stored in backups |

## Day to day

Start the server again later with `npm start` from the repository folder. You do not need to build again unless the client source changed. A new API route or database change needs a server restart. A client rebuild does not: the running server serves `client/dist`, and the HTML is not cached.
