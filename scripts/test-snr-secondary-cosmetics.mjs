import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import memoryjs from 'memoryjs';

const cache = resolve('.cache/snr-secondary-tests');
await mkdir(cache, { recursive: true });
const bundled = await build({
	entryPoints: ['src/main/snrSecondaryCosmetics.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
});
await writeFile(join(cache, 'mapping.mjs'), bundled.outputFiles[0].contents);
const { isSnrSecondaryLayout, readSnrSecondaryCosmetics } = await import(pathToFileURL(join(cache, 'mapping.mjs')));
const trackerBundle = await build({
	entryPoints: ['src/main/snrLiveTracker.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
});
await writeFile(join(cache, 'tracker.mjs'), trackerBundle.outputFiles[0].contents);
const { SnrLiveTracker } = await import(pathToFileURL(join(cache, 'tracker.mjs')));
for (const pointerSize of [4, 8]) {
	const layout = {
		pid: 7,
		pointerSize,
		controlClass: 0x30000,
		cosmeticsClass: 0x50000,
		playerIdOffset: 2 * pointerSize,
		cosmeticsOffset: 3 * pointerSize,
		layers: [{ address: 0x40000, class: 0x50000, hat2Id: 'Modded_Test_Hat', visor2Id: 'Modded_Test_Visor' }],
	};
	const memory = new Map([
		[0x20000, layout.controlClass],
		[0x20000 + layout.cosmeticsOffset, 0x40000],
		[0x40000, layout.cosmeticsClass],
	]);
	const read = (address, size) => {
		if (address === 0x20000 + layout.playerIdOffset && size === 1) return Buffer.from([1]);
		const bytes = Buffer.alloc(size),
			value = memory.get(address);
		assert.ok(value !== undefined);
		if (size === 8) bytes.writeBigUInt64LE(BigInt(value));
		else bytes.writeUInt32LE(value);
		return bytes;
	};
	const player = { id: 1, objectPtr: 0x20000, disconnected: false };
	assert.ok(isSnrSecondaryLayout(layout, 7));
	assert.ok(!isSnrSecondaryLayout(layout, 8));
	assert.ok(!isSnrSecondaryLayout({ ...layout, layers: [...layout.layers, layout.layers[0]] }, 7));
	assert.deepEqual(readSnrSecondaryCosmetics(layout, player, read), {
		snrHat2Id: 'Modded_Test_Hat',
		snrVisor2Id: 'Modded_Test_Visor',
	});
	for (const change of [{ id: 2 }, { disconnected: true }, { objectPtr: 0 }])
		assert.equal(readSnrSecondaryCosmetics(layout, { ...player, ...change }, read).snrHat2Id, undefined);
	let reads = 0;
	const changing = (address, size) =>
		address === player.objectPtr && ++reads > 1 ? Buffer.alloc(size) : read(address, size);
	assert.equal(readSnrSecondaryCosmetics(layout, player, changing).snrVisor2Id, undefined);
	assert.equal(readSnrSecondaryCosmetics({ ...layout, layers: [] }, player, read).snrHat2Id, undefined);
	assert.equal(
		readSnrSecondaryCosmetics(
			{ ...layout, layers: [{ ...layout.layers[0], hat2Id: null, visor2Id: null }] },
			player,
			read
		).snrVisor2Id,
		undefined
	);
}

const helper = join(cache, 'helper'),
	fixture = join(cache, 'fixture');
await mkdir(helper, { recursive: true });
await mkdir(fixture, { recursive: true });
for (const name of (await readdir('tools/SnrRoleReader')).filter(
	(name) => name.endsWith('.cs') || name.endsWith('.csproj')
)) {
	let source = await readFile(join('tools/SnrRoleReader', name), 'utf8');
	if (name === 'Program.cs' && process.argv.includes('--baseline'))
		source = execFileSync(
			'git',
			['-c', `safe.directory=${process.cwd().replaceAll('\\', '/')}`, 'show', 'HEAD:tools/SnrRoleReader/Program.cs'],
			{ encoding: 'utf8' }
		);
	if (name === 'Program.cs')
		source = source.replace('process.ProcessName != "Among Us"', 'process.ProcessName != "SnrCostumeFixture"');
	if (name.endsWith('.csproj'))
		source = source.replace('win-x86', 'win-x64').replace('<SelfContained>true', '<SelfContained>false');
	await writeFile(join(helper, name), source);
}
const project = (name) =>
	`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AssemblyName>${name}</AssemblyName><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>`;
await mkdir(join(fixture, 'native'), { recursive: true });
await mkdir(join(fixture, 'plugin'), { recursive: true });
await writeFile(join(fixture, 'native/Native.csproj'), project('Assembly-CSharp'));
await writeFile(
	join(fixture, 'native/Native.cs'),
	`using System.Runtime.InteropServices;
public class CosmeticsLayer { public nint pooledPtr; public static nint NativeFieldInfoPtr_bodyType=Native.Field("bodyType",Native.CosmeticsClass,16); }
public class PlayerControl { public nint pooledPtr; public static nint NativeFieldInfoPtr_PlayerId=Native.Field("PlayerId",Native.ControlClass,16); public static nint NativeFieldInfoPtr_cosmetics=Native.Field("cosmetics",Native.ControlClass,24); }
public static class Native {
 public static nint ControlClass=Marshal.AllocHGlobal(32),CosmeticsClass=Marshal.AllocHGlobal(32);
 public static nint Field(string name,nint parent,int offset){var p=Marshal.AllocHGlobal(32);Marshal.WriteIntPtr(p,Marshal.StringToHGlobalAnsi(name));Marshal.WriteIntPtr(p,16,parent);Marshal.WriteInt32(p,24,offset);return p;}
 public static (PlayerControl,CosmeticsLayer) Create(){var c=Marshal.AllocHGlobal(64);var l=Marshal.AllocHGlobal(64);Marshal.WriteIntPtr(c,ControlClass);Marshal.WriteByte(c,16,1);Marshal.WriteIntPtr(c,24,l);Marshal.WriteIntPtr(l,CosmeticsClass);return(new(){pooledPtr=c},new(){pooledPtr=l});}
}`
);
await writeFile(
	join(fixture, 'plugin/Plugin.csproj'),
	project('SuperNewRoles').replace(
		'</Project>',
		'<ItemGroup><ProjectReference Include="../native/Native.csproj"/></ItemGroup></Project>'
	)
);
await writeFile(
	join(fixture, 'plugin/Plugin.cs'),
	`namespace SuperNewRoles.Modules { public class ExPlayerControl { public static ExPlayerControl[]? _exPlayerControlsArray; } }
namespace SuperNewRoles.CustomCosmetics.UI {
 public class Package { public string name="Fixture"; }
 public class Data { public Package package=new();public string hat_id="Hat",visor_id="Visor"; }
 public class ModdedHatDataWrapper { public Data _data=new(); }
 public class ModdedVisorDataWrapper { public Data _data=new(); }
}
namespace SuperNewRoles.CustomCosmetics.CosmeticsPlayer {
 public class HatSlot { public Dictionary<int,object> Hats=new();public int CurrentHatType; }
 public class VisorSlot { public Dictionary<int,object> Visors=new();public int CurrentVisorType; }
 public class Layer { public CosmeticsLayer cosmeticsLayer=new();public HatSlot hat2=new();public VisorSlot visor2=new(); }
 public static class CustomCosmeticsLayers { public static Dictionary<CosmeticsLayer,Layer> layers=new(); }
}`
);
await writeFile(
	join(fixture, 'Host.csproj'),
	project('SnrCostumeFixture')
		.replace('</PropertyGroup>', '<OutputType>Exe</OutputType></PropertyGroup>')
		.replace(
			'</Project>',
			'<ItemGroup><Compile Remove="native/**/*.cs;plugin/**/*.cs"/><ProjectReference Include="plugin/Plugin.csproj"/></ItemGroup></Project>'
		)
);
await writeFile(
	join(fixture, 'Program.cs'),
	`using System.Runtime.InteropServices;using System.Text.Json;using SuperNewRoles.CustomCosmetics.CosmeticsPlayer;using SuperNewRoles.CustomCosmetics.UI;
var (player,cosmetics)=Native.Create();var layer=new Layer{cosmeticsLayer=new(){pooledPtr=cosmetics.pooledPtr}};
layer.hat2.Hats[0]=new ModdedHatDataWrapper();layer.visor2.Visors[0]=new ModdedVisorDataWrapper();
layer.hat2.Hats[1]=new ModdedHatDataWrapper{_data=new(){hat_id="Changed"}};layer.visor2.Visors[1]=new ModdedVisorDataWrapper{_data=new(){visor_id="Changed"}};
CustomCosmeticsLayers.layers[cosmetics]=layer;_ = PlayerControl.NativeFieldInfoPtr_cosmetics;_ = PlayerControl.NativeFieldInfoPtr_PlayerId;_ = CosmeticsLayer.NativeFieldInfoPtr_bodyType;
SuperNewRoles.Modules.ExPlayerControl._exPlayerControlsArray=null;
Console.WriteLine(JsonSerializer.Serialize(new {objectPtr=(long)player.pooledPtr,id=1}));
while(Console.ReadLine() is string command){switch(command){case "changed":layer.hat2.CurrentHatType=1;layer.visor2.CurrentVisorType=1;break;case "empty":layer.hat2.CurrentHatType=2;layer.visor2.CurrentVisorType=2;break;case "gc":GC.Collect(2,GCCollectionMode.Forced,true,true);break;case "wrong-owner":Marshal.WriteByte(player.pooledPtr,16,2);break;case "empty-role-array":SuperNewRoles.Modules.ExPlayerControl._exPlayerControlsArray=new SuperNewRoles.Modules.ExPlayerControl[256];break;}Console.WriteLine("ok");}
GC.KeepAlive(player);GC.KeepAlive(cosmetics);GC.KeepAlive(layer);`
);
execFileSync('dotnet', ['build', join(helper, 'SnrRoleReader.csproj'), '-c', 'Release', '-v', 'quiet'], {
	windowsHide: true,
	stdio: 'pipe',
});
execFileSync('dotnet', ['build', join(fixture, 'Host.csproj'), '-c', 'Release', '-v', 'quiet'], {
	windowsHide: true,
	stdio: 'pipe',
});
const child = spawn(join(fixture, 'bin/Release/net8.0/SnrCostumeFixture.exe'), [], {
	windowsHide: true,
	stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
let handle;
try {
	const [ready] = await once(lines, 'line');
	const player = { ...JSON.parse(ready), disconnected: false };
	handle = memoryjs.openProcess(child.pid);
	const read = (address, length) => memoryjs.readBuffer(handle.handle, address, length);
	const capture = () =>
		JSON.parse(
			execFileSync('dotnet', [join(helper, 'bin/Release/net8.0/win-x64/SnrRoleReader.dll'), String(child.pid)], {
				windowsHide: true,
				encoding: 'utf8',
				timeout: 45000,
			})
		);
	const command = async (value) => {
		const reply = once(lines, 'line');
		child.stdin.write(value + '\n');
		await reply;
	};
	const first = capture();
	assert.equal(first.status, 'ok', JSON.stringify(first));
	assert.deepEqual(first.players, [], 'Uninitialized role array is independent from costumes');
	assert.ok(isSnrSecondaryLayout(first.secondaryCosmetics, child.pid));
	const tracker = new SnrLiveTracker(async () => first);
	assert.ok(tracker.accept(child.pid, first), 'Roleless publication is accepted');
	assert.equal(tracker.update(child.pid, 'lobby', read).size, 0, 'Costumes grant no roles');
	assert.equal(tracker.cosmetics(player, read).snrHat2Id, 'Modded_Fixture_Hat');
	assert.deepEqual(readSnrSecondaryCosmetics(first.secondaryCosmetics, player, read), {
		snrHat2Id: 'Modded_Fixture_Hat',
		snrVisor2Id: 'Modded_Fixture_Visor',
	});
	await command('empty-role-array');
	assert.deepEqual(capture().players, []);
	await command('changed');
	await command('gc');
	assert.deepEqual(readSnrSecondaryCosmetics(capture().secondaryCosmetics, player, read), {
		snrHat2Id: 'Modded_Fixture_Changed',
		snrVisor2Id: 'Modded_Fixture_Changed',
	});
	await command('empty');
	assert.equal(
		readSnrSecondaryCosmetics(capture().secondaryCosmetics, player, read).snrHat2Id,
		undefined,
		'Empty selected outfit never revives default'
	);
	await command('wrong-owner');
	assert.equal(readSnrSecondaryCosmetics(first.secondaryCosmetics, player, read).snrVisor2Id, undefined);
	tracker.update(child.pid, 'another-lobby', read);
	assert.equal(
		tracker.cosmetics(player, read).snrHat2Id,
		undefined,
		'New scopes clear the previous publication immediately'
	);
	console.log(
		'PASS SNR secondary: x86/x64 validation, native owner changes, roleless real CLR helper, outfit switch/clear and GC'
	);
} finally {
	if (handle) memoryjs.closeProcess(handle.handle);
	child.stdin.end();
	child.kill();
	lines.close();
}
