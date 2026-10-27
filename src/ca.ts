// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { getCACertificates } from "node:tls";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const CA_DIRECTORIES = ["/etc/ssl/certs", "/etc/pki/tls/certs", "/etc/pki/ca-trust/extracted/pem", "/etc/ssl", "/usr/local/share/ca-certificates", "/usr/share/ca-certificates"];

function pemBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) blocks.push(match[0]);
    return blocks;
}

function addFile(filePath: string, out: Set<string>): void {
    try {
        const text = readFileSync(filePath, "utf8");
        for (const block of pemBlocks(text)) out.add(block);
    } catch {
        // unreadable or binary: skip
    }
}

function addDirectory(directory: string, out: Set<string>): void {
    let entries: string[];
    try {
        entries = readdirSync(directory);
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(directory, entry);
        try {
            if (!statSync(full).isFile()) continue;
        } catch {
            continue;
        }
        addFile(full, out);
    }
}

export function systemCaCertificates(): string[] {
    const out = new Set<string>();
    try {
        for (const cert of getCACertificates("default")) out.add(cert);
    } catch {
        // ignore
    }
    try {
        for (const cert of getCACertificates("system")) out.add(cert);
    } catch {
        // ignore
    }
    const fileVariables = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
    for (const name of fileVariables) {
        const value = process.env[name];
        if (value) addFile(value, out);
    }
    const directoryValue = process.env.SSL_CERT_DIR;
    if (directoryValue) {
        for (const part of directoryValue.split(":")) if (part) addDirectory(part, out);
    }
    for (const directory of CA_DIRECTORIES) addDirectory(directory, out);
    return [...out];
}

export function hasNssCaStore(certificates: string[]): boolean {
    const hasCertutil = (process.env.PATH ?? "").split(":").some((directory) => {
        try {
            return existsSync(path.join(directory, "certutil")) && statSync(path.join(directory, "certutil")).isFile();
        } catch {
            return false;
        }
    });
    if (!hasCertutil) return false;
    const database = path.join(homedir(), ".pki", "nssdb");
    try {
        mkdirSync(database, { recursive: true });
    } catch {
        return false;
    }
    const databasePath = `sql:${database}`;
    const stamp = path.join(database, ".spiderlint-ca-stamp");
    const fingerprint = createHash("sha256").update(certificates.join("")).digest("hex");
    try {
        if (existsSync(stamp) && readFileSync(stamp, "utf8") === fingerprint) return true;
    } catch {
        // fall through
    }
    if (!existsSync(path.join(database, "cert9.db"))) {
        const passwordFile = path.join(database, ".spiderlint-pw.txt");
        try {
            writeFileSync(passwordFile, "\n");
            spawnSync("certutil", ["-N", "-d", databasePath, "-f", passwordFile], { stdio: "ignore" });
        } catch {
            // ignore
        } finally {
            try {
                unlinkSync(passwordFile);
            } catch {
                // ignore
            }
        }
    }
    const passwordFile = path.join(database, ".spiderlint-pw.txt");
    try {
        writeFileSync(passwordFile, "\n");
    } catch {
        // ignore
    }
    let index = 0;
    for (const pem of certificates) {
        const file = path.join(database, `.spiderlint-ca-${index}.pem`);
        try {
            writeFileSync(file, pem);
            spawnSync("certutil", ["-A", "-d", databasePath, "-f", passwordFile, "-n", `spiderlint-ca-${index}`, "-t", "C,,", "-i", file], { stdio: "ignore" });
        } catch {
            // ignore
        } finally {
            try {
                unlinkSync(file);
            } catch {
                // ignore
            }
        }
        index += 1;
    }
    try {
        unlinkSync(passwordFile);
    } catch {
        // ignore
    }
    try {
        writeFileSync(stamp, fingerprint);
    } catch {
        // ignore
    }
    return true;
}
