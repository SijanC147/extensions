import { fileExists } from "../utils";
import * as afs from "fs/promises";
import * as os from "os";
import path from "path";
import * as child_process from "child_process";
import { cursorPath as cursorPathPref, extraCursorArgs as extraCursorArgsPref } from "../preferences";

const DEFAULT_CURSOR_CLI = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

interface ExtensionMetaRoot {
  identifier: ExtensionIdentifier;
  version: string;
  location: ExtensionLocation | string;
  metadata?: ExtensionMetadata;
}

interface ExtensionIdentifier {
  id: string;
  uuid: string;
}

interface ExtensionLocation {
  $mid: number;
  fsPath: string;
  path: string;
  scheme: string;
}

interface ExtensionMetadata {
  id: string;
  publisherId?: string;
  publisherDisplayName?: string;
  targetPlatform?: string;
  isApplicationScoped?: boolean;
  updated?: boolean;
  isPreReleaseVersion: boolean;
  installedTimestamp?: number;
  preRelease?: boolean;
}

export interface Extension {
  id: string;
  name: string;
  version: string;
  preRelease?: boolean;
  icon?: string;
  updated?: boolean;
  fsPath: string;
  publisherId?: string;
  publisherDisplayName?: string;
  preview?: boolean;
  installedTimestamp?: number;
}

interface PackageJSONInfo {
  displayName?: string;
  icon?: string;
  preview?: boolean;
}

function getNLSVariable(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  const m = text.match(/%(.+)%/);
  if (m) {
    return m[1];
  }
}

export function getCursorCLIFilename(): string {
  const configured = cursorPathPref?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_CURSOR_CLI;
}

export function getExtraCursorArgs(): string[] {
  return (extraCursorArgsPref ?? "").trim().split(/\s+/).filter(Boolean);
}

function resolveTargetPath(target: string): string {
  if (target.startsWith("file://")) {
    try {
      return decodeURIComponent(target.slice("file://".length));
    } catch {
      return target.slice("file://".length);
    }
  }
  return target;
}

function sanitizeLaunchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const isPosixLocale = (v: string | undefined) => !!v && !v.includes("-u-");
  for (const key of Object.keys(env)) {
    if ((key === "LC_ALL" || key.startsWith("LC_")) && !isPosixLocale(env[key])) {
      delete env[key];
    }
  }
  if (!isPosixLocale(env.LANG)) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function openProjectWithCursor(target: string): void {
  const cli = getCursorCLIFilename();
  const args = [...getExtraCursorArgs(), resolveTargetPath(target)];
  const cmdline = [cli, ...args].map(shellQuote).join(" ");
  const shell = process.env.SHELL || "/bin/zsh";
  const child = child_process.spawn(shell, ["-lc", cmdline], {
    detached: true,
    stdio: "ignore",
    env: sanitizeLaunchEnv(),
  });
  child.on("error", (err) => console.error("Cursor launch failed:", err));
  child.unref();
}

export class CursorCLI {
  private cliFilename: string;
  constructor(cliFilename: string) {
    this.cliFilename = cliFilename;
  }
  installExtensionByIDSync(id: string) {
    child_process.execFileSync(this.cliFilename, ["--install-extension", id, "--force"]);
  }
  uninstallExtensionByIDSync(id: string) {
    child_process.execFileSync(this.cliFilename, ["--uninstall-extension", id, "--force"]);
  }
}

export function getCursorCLI(): CursorCLI {
  return new CursorCLI(getCursorCLIFilename());
}

async function getPackageJSONInfo(filename: string): Promise<PackageJSONInfo | undefined> {
  try {
    if (await fileExists(filename)) {
      const packageJSONData = await afs.readFile(filename, {
        encoding: "utf-8",
      });
      const packageJSON = JSON.parse(packageJSONData);
      let displayName = packageJSON.displayName as string | undefined;
      const nlsVariable = getNLSVariable(displayName);
      const iconFilename = packageJSON.icon as string | undefined;
      const folder = path.dirname(filename);
      if (nlsVariable && nlsVariable.length > 0) {
        const nlsFilename = path.join(folder, "package.nls.json");
        try {
          if (await fileExists(nlsFilename)) {
            const nlsContent = await afs.readFile(nlsFilename, {
              encoding: "utf-8",
            });
            const nlsJSON = JSON.parse(nlsContent);
            const displayNameNLS = nlsJSON[nlsVariable] as string | undefined;
            if (displayNameNLS && displayNameNLS.length > 0) {
              displayName = displayNameNLS;
            }
          }
        } catch {
          // ignore
        }
      }
      const preview = packageJSON.preview as boolean | undefined;
      const icon = iconFilename ? path.join(folder, iconFilename) : undefined;
      return {
        displayName,
        icon,
        preview,
      };
    }
  } catch {
    //
  }
}

export async function getLocalExtensions(): Promise<Extension[] | undefined> {
  const extensionsRootFolder = path.join(os.homedir(), ".cursor/extensions");
  const extensionsManifrestFilename = path.join(extensionsRootFolder, "extensions.json");
  if (await fileExists(extensionsManifrestFilename)) {
    const data = await afs.readFile(extensionsManifrestFilename, {
      encoding: "utf-8",
    });
    const extensions = JSON.parse(data) as ExtensionMetaRoot[] | undefined;
    if (extensions && extensions.length > 0) {
      const result: Extension[] = [];
      for (const e of extensions) {
        const extFsPath =
          typeof e.location === "string"
            ? path.join(extensionsRootFolder, e.location)
            : e.location.fsPath ?? e.location.path;
        const packageFilename = path.join(extFsPath, "package.json");
        const pkgInfo = await getPackageJSONInfo(packageFilename);
        result.push({
          id: e.identifier.id,
          name: pkgInfo?.displayName || e.identifier.id,
          version: e.version,
          preRelease: e.metadata?.preRelease,
          icon: pkgInfo?.icon,
          updated: e.metadata?.updated,
          fsPath: extFsPath,
          publisherId: e.metadata?.publisherId,
          publisherDisplayName: e.metadata?.publisherDisplayName,
          preview: pkgInfo?.preview,
          installedTimestamp: e.metadata?.installedTimestamp,
        });
      }
      return result;
    }
  }
  return undefined;
}
