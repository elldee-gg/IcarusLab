# Trust the certificate

IcarusLab uses HTTPS with a certificate authority created on the server at `data/ca.crt`. Browsers reject the site until that file is installed as a trusted authority. Opening the site and clicking through the warning is not the same thing. The certificate has to be in the trusted-root store, not in Personal or Intermediate certificates.

Copy `data/ca.crt` from the server to the other device. Do not copy `data/ca.key`.

Use one of these addresses, which are printed when the server starts:

- `https://localhost:8443` on the server itself
- `https://<lan-ip>:8443` from another device, for example `https://192.168.0.82:8443`

A name or address that was not printed will still show a name mismatch after the authority is trusted. If the server's LAN address changes, see [install-server.md](install-server.md).

After installing the authority, close every window of that browser, then open the site again.

## Windows

This is the path that works in Edge and Chrome. The automatic store choice puts the file in the wrong place, and the warning stays.

1. Double-click `ca.crt`.
2. Choose **Install Certificate**.
3. Select **Current User** and continue. Choose **Local Machine** instead when every account on the PC should trust it. That choice asks for administrator approval.
4. Choose **Place all certificates in the following store**.
5. Browse, select **Trusted Root Certification Authorities**, and confirm.
6. Finish, then choose **Yes** on the security warning.

From an open PowerShell window, the same Current User install is:

```powershell
Import-Certificate -FilePath "C:\path\to\ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

Confirm the dialog. Then fully quit Edge or Chrome and open `https://localhost:8443` or the printed LAN address.

Firefox on Windows keeps its own list. Use the Firefox steps below.

## macOS

1. Double-click `ca.crt` and add it to the login keychain, or the System keychain if every account should trust it.
2. Open **Keychain Access**, select the keychain, and open **IcarusLab Local CA**.
3. Open the **Trust** section.
4. Set **When using this certificate** to **Always Trust**.
5. Close the window and enter the Mac password.

Quit the browser and open the site again.

## Linux

Debian, Ubuntu, and similar systems:

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/icaruslab.crt
sudo update-ca-certificates
```

Quit the browser and open the site again. Firefox still needs the Firefox steps below.

## Firefox

Firefox does not use the system certificate list.

1. Open Settings, Privacy & Security, Certificates, **View Certificates**.
2. Open **Authorities** and choose **Import**.
3. Select `ca.crt`.
4. Check **Trust this CA to identify websites** and confirm.

## iPhone and iPad

1. AirDrop `ca.crt`, or send it in a way the phone can download.
2. Open the file. If iOS says profile downloaded, go to Settings, General, VPN & Device Management, and install the profile.
3. Go to Settings, General, About, **Certificate Trust Settings**.
4. Enable full trust for **IcarusLab Local CA**.

Then open the printed `https://<lan-ip>:8443` address in Safari.

## Android

1. Copy `ca.crt` onto the phone.
2. Open Settings, Security, **Install a certificate**, then **CA certificate**. The menu name varies by phone. Search Settings for "CA certificate".
3. Choose the file and confirm.

Chrome on Android trusts a user-installed CA. Open the printed `https://<lan-ip>:8443` address.
