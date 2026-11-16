# IcarusLab

IcarusLab is a storage app for one house. A single Node process on a computer that stays on serves the site and the API over HTTPS. Phones and other computers on that network open `https://<server-ip>:8443`.

There is no public home page. `/` is the login page.

## Set it up

| Who is doing it | Guide |
| --- | --- |
| You, by hand | [docs/manual-install.md](docs/manual-install.md) |
| An agent on this computer | [docs/agent-setup.md](docs/agent-setup.md) |
| A phone or another computer that needs to open the site | [docs/trust-certificate.md](docs/trust-certificate.md) |

A fresh clone has no database, no certificates, and no admin phrase. The first `npm start` on that computer creates them under `data/` and `storage/`. Those directories are not in git. The phrase printed on that first start belongs to that computer only. Saving the words, trusting `data/ca.crt`, and the admin password in `.env` are the parts a person has to keep.

## Who can sign in

The admin is not a database user and has no drive. The username and password come from `.env`. After those succeed, the admin enters a 12-word phrase and lands on `/admin`. The phrase is drawn once for that `data/` folder, shown in the server log and in `data/admin-phrase.once.txt`, and stored only as a hash. The file is removed after the first successful phrase login. Restarts do not roll a new phrase.

From `/admin` the admin creates people, sets quotas, reads password-reset requests, sees this computer's CPU, memory, disks, and GPU, and schedules backups. Allow LAN is the switch that accepts other devices on the network. It is on unless an admin turns it off. The admin cannot open someone else's files.

A new person is created with the password `password`. The first login asks for a display name and a new password of at least 10 characters. Until that is done, their pages stay locked. Forgot password only notifies the admin. Reset sets the password back to `password` and asks them to set the account up again.

Each account has its own color and appearance. The choices are light, dark, or match this computer, and Windows 98, Windows XP, Windows Vista, Modern, or HTML.

## What people can do

The drive has folders, chunked uploads, download, text edit, rename, move, trash, restore, search by name, and image previews. A file is private, shared with usernames as view or edit, or available from an unguessable public link. Public files always download. They are not shown as web pages. Shared folder access applies to the files inside it.

Files live under `storage/<user id>/...`. Names live in SQLite, not in the folder path. Trash still counts toward the quota until it is deleted forever.

Uploads are split into 8 MiB pieces and can resume. The only size limit is the quota the admin set, and the server also stops an upload when the disk would have less than 512 MiB free.

The calendar is for events and tasks. An event can be timed or all day. People on this server can be invited and can answer yes, no, or maybe. A task is one day, can be shared, and can be marked done.

## Backups

In `/admin`, set an absolute folder outside `data/` and `storage/`, a cadence, and how many copies to keep. Back up now runs one immediately. Each copy contains a database snapshot, the storage files, and the server secrets: the certificate authority key, the JWT secret, and the phrase hash. The admin password stays in `.env` and is not inside the copy.

A copy that was interrupted is discarded the next time the server starts.

To restore: stop the server, replace `data/` and `storage/` with a finished copy, and start again with the same `.env`.

## Reset the phrase

Stop the server. Delete `admin_phrase_hash` and `admin_phrase_salt` from `server_meta` in `data/icarus.sqlite`, and delete `data/admin-phrase.once.txt` if it exists. The next start creates a new phrase. The words saved before that stop working.

## Develop

`npm test` runs the server tests. `npm run dev` rebuilds the client when it changes and restarts the server. Refresh the browser to see the new client. A machine that should stay running uses `npm start` after `npm run build`, not `npm run dev`.
