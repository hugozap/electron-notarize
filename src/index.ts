import * as debug from 'debug';
import * as path from 'path';

import { spawn } from './spawn';
import { withTempDir, makeSecret, parseNotarizationInfo } from './helpers';

const d = debug('electron-notarize');

export interface NotarizePasswordCredentials {
  appleId: string;
  appleIdPassword: string;
}

export interface NotarizeApiKeyCredentials {
  appleApiKey: string;
  appleApiIssuer: string;
}

export type NotarizeCredentials = NotarizePasswordCredentials | NotarizeApiKeyCredentials;

export interface NotarizeAppOptions {
  dmgPath: string;
  appBundleId: string;
}

export interface TransporterOptions {
  ascProvider?: string;
}

export interface NotarizeResult {
  uuid: string;
}

export type NotarizeStartOptions = NotarizeAppOptions & NotarizeCredentials & TransporterOptions;
export type NotarizeWaitOptions = NotarizeResult & NotarizeCredentials;
export type NotarizeStapleOptions = Pick<NotarizeAppOptions, 'dmgPath'>;
export type NotarizeOptions = NotarizeStartOptions;

function authorizationArgs(opts: NotarizeCredentials): string[] {
  if ('appleId' in opts) {
    return ['-u', makeSecret(opts.appleId), '-p', makeSecret(opts.appleIdPassword)];
  } else {
    return [
      '--apiKey',
      makeSecret(opts.appleApiKey),
      '--apiIssuer',
      makeSecret(opts.appleApiIssuer),
    ];
  }
}

export async function startNotarize(opts: NotarizeStartOptions): Promise<NotarizeResult> {
  d('starting notarize process for app:', opts.dmgPath);
  return await withTempDir<NotarizeResult>(async dir => {
    const zipPath = path.resolve(dir, `${path.basename(opts.dmgPath, '.dmg')}.zip`);
    d('zipping application to:', zipPath);
    const zipResult = await spawn('zip', ['-r', '-y', zipPath, path.basename(opts.dmgPath)], {
      cwd: path.dirname(opts.dmgPath),
    });
    if (zipResult.code !== 0) {
      throw new Error(
        `Failed to zip application, exited with code: ${zipResult.code}\n\n${zipResult.output}`,
      );
    }
    d('zip succeeded, attempting to upload to Apple');

    const notarizeArgs = [
      'altool',
      '--notarize-app',
      '-f',
      zipPath,
      '--primary-bundle-id',
      opts.appBundleId,
      ...authorizationArgs(opts),
    ];

    if (opts.ascProvider) {
      notarizeArgs.push('-itc_provider', opts.ascProvider);
    }

    const result = await spawn('xcrun', notarizeArgs);
    if (result.code !== 0) {
      throw new Error(`Failed to upload dmg to Apple's notarization servers\n\n${result.output}`);
    }
    d('upload success');

    const uuidMatch = /\nRequestUUID = (.+?)\n/g.exec(result.output);
    if (!uuidMatch) {
      throw new Error(`Failed to find request UUID in output:\n\n${result.output}`);
    }

    d('found UUID:', uuidMatch[1]);

    return {
      uuid: uuidMatch[1],
    };
  });
}

export async function waitForNotarize(opts: NotarizeWaitOptions): Promise<void> {
  d('checking notarization status:', opts.uuid);
  const result = await spawn('xcrun', [
    'altool',
    '--notarization-info',
    opts.uuid,
    ...authorizationArgs(opts),
  ]);
  if (result.code !== 0) {
    // These checks could fail for all sorts of reasons, including:
    //  * The status of a request isn't available as soon as the upload request returns, so
    //    it may just not be ready yet.
    //  * If using keychain password, user's mac went to sleep and keychain locked.
    //  * Regular old connectivity failure.
    d(
      `Failed to check status of notarization request, retrying in 30 seconds: ${opts.uuid}\n\n${result.output}`,
    );
    await delay(30000);
    return waitForNotarize(opts);
  }
  const notarizationInfo = parseNotarizationInfo(result.output);

  if (notarizationInfo.status === 'in progress') {
    d('still in progress, waiting 30 seconds');
    await delay(30000);
    return waitForNotarize(opts);
  }

  d('notarzation done with info:', notarizationInfo);

  if (notarizationInfo.status === 'invalid') {
    d('notarization failed');
    throw new Error(`Apple failed to notarize your application, check the logs for more info

Status Code: ${notarizationInfo.statusCode || 'No Code'}
Message: ${notarizationInfo.statusMessage || 'No Message'}
Logs: ${notarizationInfo.logFileUrl}`);
  }

  if (notarizationInfo.status !== 'success') {
    throw new Error(`Unrecognized notarization status: "${notarizationInfo.status}"`);
  }

  d('notarization was successful');
  return;
}

export async function stapleApp(opts: NotarizeStapleOptions): Promise<void> {
  d('attempting to staple app:', opts.dmgPath);
  const result = await spawn('xcrun', ['stapler', 'staple', '-v', path.basename(opts.dmgPath)], {
    cwd: path.dirname(opts.dmgPath),
  });

  if (result.code !== 0) {
    throw new Error(
      `Failed to staple your application with code: ${result.code}\n\n${result.output}`,
    );
  }

  d('staple succeeded');
  return;
}

export async function notarize({
  appBundleId,
  dmgPath,
  ascProvider,
  ...authOptions
}: NotarizeOptions) {
  const { uuid } = await startNotarize({
    appBundleId,
    dmgPath,
    ascProvider,
    ...authOptions,
  });
  /**
   * Wait for Apples API to initialize the status UUID
   *
   * If we start checking too quickly the UUID is not ready yet
   * and this step will fail.  It takes Apple a number of minutes
   * to actually complete the job so an extra 10 second delay here
   * is not a big deal
   */
  d('notarization started, waiting for 10 seconds before pinging Apple for status');
  await delay(10000);
  d('starting to poll for notarization status');
  await waitForNotarize({ uuid, ...authOptions });
  await stapleApp({ dmgPath });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
