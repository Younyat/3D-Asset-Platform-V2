import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const warehouseRoot = resolve(process.cwd(), process.env.ASSET_FORGE_WAREHOUSE_DIR ?? 'project-warehouse');
const modbusControllerScript = resolve(process.cwd(), 'scripts', 'modbus_visual_controller.mjs');

const waitForModbusController = async (url: string, timeoutMs = 8000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(700) });
      const payload = await response.json() as { service?: string };
      if (response.ok && payload.service === 'visual-modbus-robot-controller') return true;
    } catch {
      // The local controller may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  return false;
};

const modbusControllerPlugin = () => {
  let controllerProcess: ChildProcess | undefined;
  return {
    name: 'local-modbus-controller-launcher',
    configureServer(server) {
      server.middlewares.use('/__modbus-controller/start', async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: 'POST required' }));
          return;
        }

        const url = 'http://127.0.0.1:8765';
        try {
          if (!(await waitForModbusController(url, 900))) {
            controllerProcess = spawn(process.execPath, [modbusControllerScript, '--host=127.0.0.1', '--port=8765'], {
              cwd: process.cwd(),
              stdio: 'ignore',
              windowsHide: true,
              shell: false,
            });
            controllerProcess.unref();
          }
          if (!(await waitForModbusController(url))) throw new Error('The Modbus Controller did not become available on port 8765.');
          response.end(JSON.stringify({ ok: true, url, reused: !controllerProcess || controllerProcess.exitCode === null }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Controller start failed' }));
        }
      });
    },
  };
};

const validOpenPlcHost = (value: string) => /^[a-zA-Z0-9.-]+$/.test(value) && value.length <= 253;

const openPlcRequest = (options: { host: string; port: number; unitId: number; functionCode: number; address: number; quantity?: number; values?: number[]; timeoutMs?: number }) =>
  new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const transactionId = Math.floor(Math.random() * 0xffff);
    const values = options.values ?? [];
    const pdu = options.functionCode === 3
      ? Buffer.from([3, options.address >> 8, options.address & 0xff, (options.quantity ?? 1) >> 8, (options.quantity ?? 1) & 0xff])
      : options.functionCode === 6
        ? Buffer.from([6, options.address >> 8, options.address & 0xff, values[0] >> 8, values[0] & 0xff])
        : Buffer.from([16, options.address >> 8, options.address & 0xff, values.length >> 8, values.length & 0xff, values.length * 2, ...values.flatMap((word) => [word >> 8, word & 0xff])]);
    const mbap = Buffer.from([transactionId >> 8, transactionId & 0xff, 0, 0, 0, pdu.length + 1, options.unitId]);
    const requestFrame = Buffer.concat([mbap, pdu]);
    const socket = net.createConnection({ host: options.host, port: options.port });
    const chunks: Buffer[] = [];
    const finish = (error?: Error, response?: Buffer) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(response ?? Buffer.alloc(0));
    };
    socket.setTimeout(options.timeoutMs ?? 1200);
    socket.on('connect', () => socket.write(requestFrame));
    socket.on('timeout', () => finish(new Error('OpenPLC Modbus TCP timeout')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks);
      if (response.length < 7) return;
      const expectedLength = 6 + response.readUInt16BE(4);
      if (response.length < expectedLength) return;
      if (response.readUInt16BE(0) !== transactionId) return finish(new Error('OpenPLC transaction ID mismatch'));
      if (response[6] !== options.unitId) return finish(new Error('OpenPLC Unit ID mismatch'));
      if ((response[7] & 0x80) !== 0) return finish(new Error(`OpenPLC Modbus exception ${response[8] ?? 0}`));
      finish(undefined, response.subarray(0, expectedLength));
    });
  });

const openPlcPlugin = () => ({
  name: 'openplc-modbus-tcp-gateway',
  configureServer(server) {
    server.middlewares.use('/__openplc/read', async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        const url = new URL(request.url ?? '', 'http://127.0.0.1');
        const host = url.searchParams.get('host') ?? '127.0.0.1';
        const port = Number(url.searchParams.get('port') ?? 502);
        const unitId = Number(url.searchParams.get('unitId') ?? 1);
        const address = Number(url.searchParams.get('address') ?? 100);
        const quantity = Number(url.searchParams.get('quantity') ?? 12);
        if (!validOpenPlcHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(unitId) || unitId < 0 || unitId > 255 || !Number.isInteger(address) || address < 0 || address > 65535 || !Number.isInteger(quantity) || quantity < 1 || quantity > 125) throw new Error('Invalid OpenPLC endpoint or register range');
        const frame = await openPlcRequest({ host, port, unitId, functionCode: 3, address, quantity });
        const byteCount = frame[8];
        const registers = Array.from({ length: Math.floor(byteCount / 2) }, (_, index) => frame.readUInt16BE(9 + index * 2));
        response.end(JSON.stringify({ ok: true, host, port, unitId, address, quantity, registers, transactionId: frame.readUInt16BE(0), functionCode: frame[7], receivedAt: new Date().toISOString() }));
      } catch (error) {
        response.statusCode = 502;
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'OpenPLC read failed' }));
      }
    });

    server.middlewares.use('/__openplc/probe', async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url ?? '', 'http://127.0.0.1');
      const host = url.searchParams.get('host') ?? '127.0.0.1';
      const requestedPort = Number(url.searchParams.get('port') ?? 502);
      const requestedUnit = Number(url.searchParams.get('unitId') ?? 1);
      if (!validOpenPlcHost(host)) return void (response.statusCode = 400, response.end(JSON.stringify({ ok: false, error: 'Invalid OpenPLC host' })));
      const ports = [...new Set([requestedPort, 502, 5020])].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
      const unitIds = [...new Set([requestedUnit, 1, 0])].filter((unitId) => Number.isInteger(unitId) && unitId >= 0 && unitId <= 255);
      const attempts: Array<{ port: number; unitId: number; result: string }> = [];
      for (const port of ports) {
        for (const unitId of unitIds) {
          try {
            const frame = await openPlcRequest({ host, port, unitId, functionCode: 3, address: 90, quantity: 16, timeoutMs: 650 });
            const byteCount = frame[8];
            const registers = Array.from({ length: Math.floor(byteCount / 2) }, (_, index) => frame.readUInt16BE(9 + index * 2));
            const signed = registers.map((word) => (word & 0x8000 ? word - 0x10000 : word));
            const signature = registers.length >= 16 && registers[0] <= 2 && registers[1] <= 2 && registers[2] <= 6;
            attempts.push({ port, unitId, result: signature ? 'cobot-profile' : 'holding-registers-readable' });
            if (signature) {
              response.end(JSON.stringify({ ok: true, detected: true, host, port, unitId, address: 100, quantity: 6, dataFormat: 'int16-rad-x10000', commandAddress: 90, rawAddress: 90, registers, signed, attempts, receivedAt: new Date().toISOString() }));
              return;
            }
          } catch (error) {
            attempts.push({ port, unitId, result: error instanceof Error ? error.message : 'probe failed' });
          }
        }
      }
      response.statusCode = 502;
      response.end(JSON.stringify({ ok: false, detected: false, error: 'Cobot OpenPLC register signature not found at %QW90..%QW105', attempts }));
    });

    server.middlewares.use('/__openplc/write', async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'POST') return void (response.statusCode = 405, response.end(JSON.stringify({ error: 'POST required' })));
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const host = String(parsed.host ?? '127.0.0.1');
          const port = Number(parsed.port ?? 502);
          const unitId = Number(parsed.unitId ?? 1);
          const address = Number(parsed.address ?? 100);
          const values = Array.isArray(parsed.values) ? parsed.values.map(Number) : [];
          if (!validOpenPlcHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(address) || address < 0 || address > 65535 || !values.length || values.length > 123 || values.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) throw new Error('Invalid OpenPLC write request');
          const functionCode = values.length === 1 ? 6 : 16;
          const frame = await openPlcRequest({ host, port, unitId, functionCode, address, values });
          response.end(JSON.stringify({ ok: true, functionCode, transactionId: frame.readUInt16BE(0), receivedAt: new Date().toISOString() }));
        } catch (error) {
          response.statusCode = 502;
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'OpenPLC write failed' }));
        }
      });
    });
  },
});

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

const warehousePlugin = () => ({
  name: 'local-warehouse-api',
  configureServer(server) {
    server.middlewares.use('/__warehouse/save', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const projectDir = join(warehouseRoot, projectId);
          await mkdir(projectDir, { recursive: true });

          const manifestPath = join(projectDir, 'manifest.json');
          let manifest = { projectId, items: [] };
          try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          } catch {
            manifest = { projectId, items: [] };
          }

          const existing = new Set(manifest.items.map((item) => item.key));
          let saved = 0;
          let skipped = 0;
          for (const entry of items) {
            const key = safeName(String(entry.key ?? entry.item?.id ?? randomUUID()));
            const fileName = `${key}.assetpart.json`;
            if (existing.has(key)) {
              skipped += 1;
              continue;
            }
            const payload = JSON.stringify(entry.item, null, 2);
            await writeFile(join(projectDir, fileName), payload, 'utf8');
            manifest.items.push({
              key,
              fileName,
              name: entry.item?.name ?? key,
              itemType: entry.item?.itemType ?? 'part',
              category: entry.item?.category ?? 'General',
              className: entry.item?.className ?? 'Component',
              savedAt: new Date().toISOString(),
              sizeBytes: Buffer.byteLength(payload),
            });
            existing.add(key);
            saved += 1;
          }

          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ saved, skipped, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/save-glb', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on('end', async () => {
        try {
          const url = new URL(request.url ?? '', 'http://127.0.0.1');
          const projectId = safeName(String(url.searchParams.get('projectId') ?? 'default-project'));
          const key = safeName(String(url.searchParams.get('key') ?? randomUUID()));
          const overwrite = url.searchParams.get('overwrite') === '1';
          const projectDir = join(warehouseRoot, projectId);
          await mkdir(projectDir, { recursive: true });

          const manifestPath = join(projectDir, 'manifest.json');
          let manifest = { projectId, items: [] };
          try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          } catch {
            manifest = { projectId, items: [] };
          }

          const existingIndex = manifest.items.findIndex((item) => item.key === key);
          if (existingIndex >= 0 && !overwrite) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ saved: 0, skipped: 1, manifest }));
            return;
          }

          const previousFileName = existingIndex >= 0 ? manifest.items[existingIndex]?.fileName : undefined;
          const fileName = previousFileName && String(previousFileName).toLowerCase().endsWith('.glb') ? previousFileName : `${key}.glb`;
          const payload = Buffer.concat(chunks);
          await writeFile(join(projectDir, fileName), payload);
          const nextEntry = {
            key,
            fileName,
            name: key,
            itemType: 'part',
            category: 'General',
            className: 'Component',
            savedAt: new Date().toISOString(),
            sizeBytes: payload.byteLength,
          };
          if (existingIndex >= 0) manifest.items[existingIndex] = { ...manifest.items[existingIndex], ...nextEntry };
          else manifest.items.push(nextEntry);

          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ saved: 1, skipped: 0, replaced: existingIndex >= 0 ? 1 : 0, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse GLB save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/metadata', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const metadata = parsed.metadata ?? {};
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ updated: 0 }));
            return;
          }

          manifest.items[index] = {
            ...manifest.items[index],
            name: metadata.name ?? manifest.items[index].name,
            itemType: metadata.itemType ?? manifest.items[index].itemType,
            category: metadata.category ?? manifest.items[index].category,
            className: metadata.className ?? manifest.items[index].className,
            code: metadata.code,
            objectName: metadata.objectName,
            sourceAssetName: metadata.sourceAssetName,
            material: metadata.material,
            thumbnailDataUrl: metadata.thumbnailDataUrl,
            functionalComponent: metadata.functionalComponent,
            functionalAssembly: metadata.functionalAssembly,
            savedAt: new Date().toISOString(),
          };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ updated: 1, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse metadata save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/load', async (request, response) => {
      try {
        const url = new URL(request.url ?? '', 'http://127.0.0.1');
        const projectId = safeName(String(url.searchParams.get('projectId') ?? 'default-project'));
        const projectDir = join(warehouseRoot, projectId);
        const manifestPath = join(projectDir, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const items = [];
        for (const entry of manifest.items ?? []) {
          if (String(entry.fileName).toLowerCase().endsWith('.glb')) {
            const buffer = await readFile(join(projectDir, entry.fileName));
            const geometry = {
              kind: 'imported-model',
              assetName: entry.fileName,
              assetDataUrl: `data:model/gltf-binary;base64,${buffer.toString('base64')}`,
              sourceFormat: 'glb',
              importScale: 1,
              importOffset: [0, 0, 0],
              originalBounds: [1, 1, 1],
              normalizedBounds: [1, 1, 1],
              bones: [],
              animations: [],
              joints: [],
              validatedMotions: [],
              freePartTransforms: [],
              partMaterials: [],
              isolatedObjectNames: [],
              partObjectNames: [],
            };
            const material = entry.material ?? { name: 'Stored GLB', color: '#8b949e', roughness: 0.52, metalness: 0.08 };
            const storageMetadata = {
              sourceFormat: 'glb',
              originalBounds: [1, 1, 1],
              storedAt: entry.savedAt,
              updatedAt: entry.savedAt,
              storageKey: entry.key,
              storageProjectId: projectId,
              storageFileName: entry.fileName,
            };

            if (entry.itemType === 'assembly') {
              items.push({
                id: `assembly_${entry.key}`,
                itemType: 'assembly',
                thumbnailDataUrl: entry.thumbnailDataUrl,
                code: entry.code ?? entry.key,
                name: entry.name,
                category: 'Assemblies',
                className: entry.className ?? 'Composite',
                sourceAssetName: entry.sourceAssetName ?? entry.fileName,
                assemblyNodes: [
                  {
                    id: `node_${entry.key}`,
                    name: entry.name,
                    geometry,
                    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                    material,
                    visible: true,
                    locked: false,
                    createdAt: entry.savedAt,
                  },
                ],
                functionalAssembly: entry.functionalAssembly,
                metadata: {
                  ...storageMetadata,
                  sourceFormat: 'assembly',
                },
              });
              continue;
            }

            items.push({
              id: `part_${entry.key}`,
              itemType: 'part',
              thumbnailDataUrl: entry.thumbnailDataUrl,
              code: entry.code ?? entry.key,
              name: entry.name,
              category: entry.category ?? 'General',
              className: entry.className ?? 'Component',
              sourceNodeId: `file_${entry.key}`,
              sourceAssetName: entry.sourceAssetName ?? entry.fileName,
              objectName: entry.objectName ?? entry.name,
              geometry,
              material,
              functionalComponent: entry.functionalComponent,
              metadata: {
                ...storageMetadata,
                sourceFormat: 'glb',
              },
            });
          } else {
            items.push(JSON.parse(await readFile(join(projectDir, entry.fileName), 'utf8')));
          }
        }
        const files = await readdir(projectDir).catch(() => []);
        const usageBytes = (
          await Promise.all(
            files.map(async (fileName) => {
              const info = await stat(join(projectDir, fileName));
              return info.size;
            }),
          )
        ).reduce((total, size) => total + size, 0);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ manifest, items, usageBytes }));
      } catch {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ manifest: { items: [] }, items: [], usageBytes: 0 }));
      }
    });

    server.middlewares.use('/__warehouse/projects', async (request, response) => {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }

      try {
        const projectNames = await readdir(warehouseRoot).catch(() => []);
        const projects = [];
        for (const projectId of projectNames) {
          const projectDir = join(warehouseRoot, projectId);
          const info = await stat(projectDir).catch(() => undefined);
          if (!info?.isDirectory()) continue;

          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const files = await readdir(projectDir).catch(() => []);
          const usageBytes = (
            await Promise.all(
              files.map(async (fileName) => {
                const fileInfo = await stat(join(projectDir, fileName));
                return fileInfo.size;
              }),
            )
          ).reduce((total, size) => total + size, 0);
          const items = Array.isArray(manifest.items) ? manifest.items : [];
          const latestSavedAt = items
            .map((item) => String(item.savedAt ?? ''))
            .filter(Boolean)
            .sort()
            .at(-1);

          projects.push({
            projectId,
            items: items.length,
            usageBytes,
            latestSavedAt: latestSavedAt ?? info.mtime.toISOString(),
          });
        }

        projects.sort((a, b) => b.latestSavedAt.localeCompare(a.latestSavedAt));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ projects }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse projects load failed' }));
      }
    });

    server.middlewares.use('/__warehouse/delete', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ deleted: 0 }));
            return;
          }

          const [entry] = manifest.items.splice(index, 1);
          if (entry?.fileName) {
            await unlink(join(projectDir, entry.fileName)).catch(() => undefined);
          }
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ deleted: 1, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse delete failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/thumbnail', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const thumbnailDataUrl = String(parsed.thumbnailDataUrl ?? '');
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0 || !thumbnailDataUrl.startsWith('data:image/')) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ updated: 0 }));
            return;
          }

          manifest.items[index] = { ...manifest.items[index], thumbnailDataUrl };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ updated: 1 }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse thumbnail save failed' }));
        }
      });
    });
  },
});

export default defineConfig({
  plugins: [react(), warehousePlugin(), modbusControllerPlugin(), openPlcPlugin()],
  server: {
    port: 5173,
  },
});
