import type { ModbusMapping, TwinBinding, TwinSignalValue } from '../../domain/twin';

export type ModbusRegisterArea = ModbusMapping['area'];

export type ModbusReadBlock = {
  connectionId: string;
  area: ModbusRegisterArea;
  address: number;
  quantity: number;
  bindingIds: string[];
};

export type ModbusWriteRequest = {
  area: ModbusRegisterArea;
  address: number;
  quantity: number;
  functionCode: 5 | 6 | 15 | 16;
  coils?: boolean[];
  registers?: number[];
};

const ensureRegister = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`Invalid Modbus register value ${value}.`);
  return value;
};

const ensureRegisters = (registers: number[], quantity: number) => {
  if (registers.length < quantity) throw new Error(`Expected ${quantity} registers, got ${registers.length}.`);
  return registers.slice(0, quantity).map(ensureRegister);
};

const dataViewFromRegisters = (registers: number[], byteOrder: ModbusMapping['byteOrder'], wordOrder: ModbusMapping['wordOrder'] = 'high-low') => {
  const orderedWords = wordOrder === 'low-high' ? [...registers].reverse() : [...registers];
  const bytes = new Uint8Array(orderedWords.length * 2);
  orderedWords.forEach((register, index) => {
    const high = (register >> 8) & 0xff;
    const low = register & 0xff;
    if (byteOrder === 'le') {
      bytes[index * 2] = low;
      bytes[index * 2 + 1] = high;
    } else {
      bytes[index * 2] = high;
      bytes[index * 2 + 1] = low;
    }
  });
  return new DataView(bytes.buffer);
};

const registersFromBytes = (bytes: Uint8Array, byteOrder: ModbusMapping['byteOrder'], wordOrder: ModbusMapping['wordOrder'] = 'high-low') => {
  const registers: number[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    registers.push(byteOrder === 'le' ? (b << 8) | a : (a << 8) | b);
  }
  return wordOrder === 'low-high' ? registers.reverse() : registers;
};

const numericValue = (value: TwinSignalValue) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Cannot encode non-numeric Modbus value ${String(value)}.`);
};

export const decodeModbusValue = (registers: number[], mapping: ModbusMapping): TwinSignalValue => {
  if (mapping.area === 'coil' || mapping.area === 'discrete-input') {
    return Boolean(registers[0]);
  }
  const quantity = mapping.quantity;
  const view = dataViewFromRegisters(ensureRegisters(registers, quantity), mapping.byteOrder, mapping.wordOrder);
  if (mapping.dataType === 'u16') return view.getUint16(0, false);
  if (mapping.dataType === 'i16') return view.getInt16(0, false);
  if (mapping.dataType === 'u32') return view.getUint32(0, false);
  if (mapping.dataType === 'i32') return view.getInt32(0, false);
  if (mapping.dataType === 'f32') return view.getFloat32(0, false);
  if (mapping.dataType === 'f64') return view.getFloat64(0, false);
  if (mapping.dataType === 'bool') return view.getUint16(0, false) !== 0;
  throw new Error(`Unsupported Modbus data type ${mapping.dataType}.`);
};

export const encodeModbusValue = (value: TwinSignalValue, mapping: ModbusMapping): ModbusWriteRequest => {
  if (mapping.area === 'coil') {
    const bool = typeof value === 'boolean' ? value : numericValue(value) !== 0;
    return { area: mapping.area, address: mapping.address, quantity: 1, functionCode: 5, coils: [bool] };
  }
  if (mapping.area === 'discrete-input' || mapping.area === 'input-register') {
    throw new Error(`Modbus area ${mapping.area} is read-only.`);
  }

  const bytes = new Uint8Array(mapping.quantity * 2);
  const view = new DataView(bytes.buffer);
  const number = numericValue(value);
  if (mapping.dataType === 'u16') view.setUint16(0, number, false);
  else if (mapping.dataType === 'i16') view.setInt16(0, number, false);
  else if (mapping.dataType === 'u32') view.setUint32(0, number, false);
  else if (mapping.dataType === 'i32') view.setInt32(0, number, false);
  else if (mapping.dataType === 'f32') view.setFloat32(0, number, false);
  else if (mapping.dataType === 'f64') view.setFloat64(0, number, false);
  else if (mapping.dataType === 'bool') view.setUint16(0, number ? 1 : 0, false);
  else throw new Error(`Unsupported Modbus data type ${mapping.dataType}.`);

  const registers = registersFromBytes(bytes, mapping.byteOrder, mapping.wordOrder);
  return {
    area: mapping.area,
    address: mapping.address,
    quantity: mapping.quantity,
    functionCode: mapping.quantity > 1 ? 16 : 6,
    registers,
  };
};

export const modbusDisplayAddressToWire = (displayAddress: string) => {
  const numeric = Number(displayAddress.trim());
  if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`Invalid Modbus display address ${displayAddress}.`);
  if (numeric >= 400001) return { area: 'holding-register' as const, address: numeric - 400001 };
  if (numeric >= 300001) return { area: 'input-register' as const, address: numeric - 300001 };
  if (numeric >= 100001) return { area: 'discrete-input' as const, address: numeric - 100001 };
  if (numeric >= 40001) return { area: 'holding-register' as const, address: numeric - 40001 };
  if (numeric >= 30001) return { area: 'input-register' as const, address: numeric - 30001 };
  if (numeric >= 10001) return { area: 'discrete-input' as const, address: numeric - 10001 };
  return { area: 'coil' as const, address: numeric - 1 };
};

export const modbusWireAddressToDisplay = (area: ModbusRegisterArea, address: number) => {
  if (!Number.isInteger(address) || address < 0) throw new Error(`Invalid Modbus wire address ${address}.`);
  if (area === 'holding-register') return String(40001 + address);
  if (area === 'input-register') return String(30001 + address);
  if (area === 'discrete-input') return String(10001 + address);
  return String(1 + address).padStart(5, '0');
};

const modbusBindings = (bindings: TwinBinding[]) =>
  bindings.filter((binding): binding is TwinBinding & { mapping: ModbusMapping } => binding.enabled && binding.protocol === 'modbus' && binding.mapping.kind === 'modbus');

export const planModbusReadBlocks = (
  bindings: TwinBinding[],
  options: {
    maxRegistersPerRequest?: number;
    maxCoilsPerRequest?: number;
    maxGap?: number;
  } = {},
): ModbusReadBlock[] => {
  const maxRegisters = options.maxRegistersPerRequest ?? 120;
  const maxCoils = options.maxCoilsPerRequest ?? 1800;
  const maxGap = options.maxGap ?? 0;
  const grouped = new Map<string, Array<TwinBinding & { mapping: ModbusMapping }>>();

  modbusBindings(bindings)
    .filter((binding) => binding.mapping.area !== 'coil' || binding.mapping.dataType === 'bool')
    .forEach((binding) => {
      const key = `${binding.connectionId}|${binding.mapping.area}`;
      grouped.set(key, [...(grouped.get(key) ?? []), binding]);
    });

  const blocks: ModbusReadBlock[] = [];
  grouped.forEach((items, key) => {
    const [connectionId, area] = key.split('|') as [string, ModbusRegisterArea];
    const maxQuantity = area === 'coil' || area === 'discrete-input' ? maxCoils : maxRegisters;
    const sorted = [...items].sort((a, b) => a.mapping.address - b.mapping.address);
    let current: ModbusReadBlock | undefined;

    sorted.forEach((binding) => {
      const start = binding.mapping.address;
      const end = binding.mapping.address + Math.max(binding.mapping.quantity, 1);
      if (!current) {
        current = { connectionId, area, address: start, quantity: end - start, bindingIds: [binding.id] };
        return;
      }
      const currentEnd = current.address + current.quantity;
      const gap = start - currentEnd;
      const mergedEnd = Math.max(currentEnd, end);
      const mergedQuantity = mergedEnd - current.address;
      if (gap <= maxGap && mergedQuantity <= maxQuantity) {
        current.quantity = mergedQuantity;
        current.bindingIds.push(binding.id);
        return;
      }
      blocks.push(current);
      current = { connectionId, area, address: start, quantity: end - start, bindingIds: [binding.id] };
    });

    if (current) blocks.push(current);
  });

  return blocks;
};

export const decodeModbusBlockSamples = (
  block: ModbusReadBlock,
  registers: number[],
  bindings: TwinBinding[],
  sequenceStart: number,
  ingestTimestampUtc: string,
  sourceTimestampUtc?: string,
) => {
  const byId = new Map(modbusBindings(bindings).map((binding) => [binding.id, binding]));
  return block.bindingIds.map((bindingId, index) => {
    const binding = byId.get(bindingId);
    if (!binding) throw new Error(`Missing binding ${bindingId} for Modbus block.`);
    const offset = binding.mapping.address - block.address;
    const rawRegisters = registers.slice(offset, offset + binding.mapping.quantity);
    return {
      bindingId,
      value: decodeModbusValue(rawRegisters, binding.mapping),
      quality: 'GOOD' as const,
      sequence: sequenceStart + index,
      ingestTimestampUtc,
      sourceTimestampUtc,
      raw: { block },
    };
  });
};
