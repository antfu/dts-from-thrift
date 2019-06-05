import * as path from 'path';
import * as fs from 'fs-extra';
import * as pb from 'protobufjs';
import glob from 'glob';
import * as os from 'os';
import {
  CMDOptions,
  FunctionEntity,
  PbNodeEntity,
  InterfaceEntity,
  EnumEntity,
  EnumEntityMember,
  InterfacePropertyEntity,
  ServiceEntity
} from '../interfaces';
import { typeMapping } from '../protobuf/typeMapping';
import {
  printEnums,
  printInternalInterfacesAndEnums,
  attachComment
} from '../protobuf/print';
import { prettier } from '../tools/format';
import combine from '../tools/combine';

export async function loadPb(options: Partial<CMDOptions>) {
  const rootDir = (options && options.root) || process.cwd();
  const files = glob
    .sync('**/*.proto', { cwd: rootDir })
    .map(d => path.resolve(rootDir, d));

  const fileList = await Promise.all(
    files.map(async filename => {
      return {
        code: (await fs.readFile(filename, 'utf8')).replace(/singular /g, ''), // FIXME: singular 解析报错，先删掉这个关键词
        filename
      };
    })
  );

  // nodeMap 用来存放所有反射对象
  // key 为 namespace 访问路径
  const nodeMap = new Map<string, PbNodeEntity[]>([]);

  const astList: pb.IParserResult[] = [];

  fileList.forEach(({ code, filename }) => {
    let ast: pb.IParserResult;
    try {
      ast = pb.parse(code, {
        keepCase: true,
        alternateCommentMode: false
      });
    } catch (e) {
      console.error(`filename: ${filename}`);
      console.error(e);
      if (options.lint) {
        process.stderr.write(`pb lint ERROR: ${filename}${os.EOL}`);
        console.error((e && e.message) || '');
      }
      return;
    }

    if (options.lint) {
      return;
    }

    const ns = ast.package;
    if (!ns) {
      console.log(`Package name not found. File: ${filename}`);
      throw new Error();
    }

    // 通过 namespace 获取 namespace 所在节点，理论上不可能为 null
    const namespaceNode: pb.Namespace | null = <pb.Namespace>(
      ast.root.lookup(ns)
    );
    if (!namespaceNode) {
      throw new Error();
    }

    astList.push(ast);
    crawlAST(namespaceNode, nodeMap, filename);
  });

  // 当所有 namespace 下的类型收集完毕，可以开始写文件了
  // 先按照 filename 聚合一下
  const filenameNodeMap = new Map<string, PbNodeEntity[]>([]);
  for (const [ns, datumList] of nodeMap) {
    for (const datum of datumList) {
      if (!filenameNodeMap.has(datum.filename)) {
        // 如果 filename 没有，创建一下
        filenameNodeMap.set(datum.filename, []);
      }
      const data = filenameNodeMap.get(datum.filename)!;
      data.push(datum);
    }
  }

  // 收集完所有文件的 nodeMap，就可以去处理 import 进来的 namespace 的类型，转成 namespace.type
  astList.forEach(ast => {
    crawlAstAndAttachNamespace(ast, nodeMap);
  });

  // 按照 filename 写文件
  await Promise.all(
    fileList.map(async ({ filename }) => {
      const data = filenameNodeMap.get(filename);
      if (!data) {
        return;
      }

      const relativePath = path.relative(rootDir, filename);
      const targetFilename = path
        .resolve(
          (options && options.tsRoot) || process.cwd() + '/typings',
          relativePath
        )
        .replace('.proto', '.d.ts');

      const namespace = data.filter(d => d.type === 'namespace')[0];
      if (!namespace) {
        return;
      }

      await fs.ensureDir(path.parse(targetFilename).dir);

      const strLines: string[] = [
        `
// generate by dts-from-protobuf
declare namespace ${namespace.meta.fullName.replace(/^\./, '')} {`,
        printEnums(
          data
            .filter(d => d.type === 'enum')
            .map(d => convertToEnumEntity(<pb.Enum>d.meta))
        ),
        printInterfaces(
          data
            .filter(d => d.type === 'message')
            .map(d => convertMessageToInterfaceEntity(<pb.Type>d.meta))
        ),
        printServices(
          data
            .filter(d => d.type === 'service')
            .map(d => convertServiceToServiceEntity(<pb.Service>d.meta))
        ),
        '}'
      ];

      await fs.writeFile(
        targetFilename,
        prettier(strLines.join(os.EOL)),
        'utf8'
      );
    })
  );

  await combine(options as any);

  return nodeMap;
}

function crawlAST(
  node: pb.ReflectionObject,
  nodeMap: Map<string, PbNodeEntity[]>,
  filename: string
) {
  const nodeList = [node];
  let current: pb.ReflectionObject | undefined;
  while ((current = nodeList.pop())) {
    const fullname = current.fullName.replace(/^\./, '');
    let data: PbNodeEntity[];
    if (nodeMap.has(fullname)) {
      // console.log(
      //   `${fullname} is duplicated defined.\nDefinition in ${filename} will be ignored.`
      // );
      data = nodeMap.get(fullname)!;
    } else {
      data = [];
      nodeMap.set(fullname, data);
    }

    if (isEnum(current)) {
      data.push({
        meta: current,
        type: 'enum',
        filename
      });
    } else if (isMessage(current)) {
      // 处理 message
      data.push({
        filename,
        meta: current,
        type: 'message'
      });
    } else if (isService(current)) {
      // 处理 service
      data.push({
        meta: current,
        type: 'service',
        filename
      });
    } else if (isNamespace(current)) {
      // 处理 namespace
      data.push({
        meta: current,
        type: 'namespace',
        filename
      });
      nodeList.push(...current.nestedArray);
    }
  }
}

function isNamespace(v: pb.ReflectionObject): v is pb.Namespace {
  return v instanceof pb.Namespace;
}

function isMessage(v: pb.ReflectionObject): v is pb.Type {
  return v instanceof pb.Type;
}

function isEnum(v: pb.ReflectionObject): v is pb.Enum {
  return v instanceof pb.Enum;
}

function isService(v: pb.ReflectionObject): v is pb.Service {
  return v instanceof pb.Service;
}

// function isMethod(v: pb.ReflectionObject): v is pb.Method {
//   return v instanceof pb.Method;
// }

// function isRpcMethod(v: pb.ReflectionObject): v is pb.Method & { type: 'rpc' } {
//   return v instanceof pb.Method && v.type === 'rpc';
// }

export function convertMethodToFunctionEntity(node: pb.Method): FunctionEntity {
  return {
    comment: node.comment || '',
    inputParams: node.requestType
      ? [
          {
            type: node.requestType,
            index: 1,
            name: 'req'
          }
        ]
      : [],
    returnType: node.responseType
  };
}

export function convertMessageToInterfaceEntity(
  node: pb.Type
): InterfaceEntity {
  const rtn: InterfaceEntity = {
    name: node.name,
    properties: {},
    childrenInterfaces: [],
    childrenEnums: []
  };

  // 获取内嵌类型
  const nested = node.nestedArray;
  nested.forEach(d => {
    if (isEnum(d)) {
      rtn.childrenEnums.push(convertToEnumEntity(d));
    } else if (isMessage(d)) {
      rtn.childrenInterfaces.push(convertMessageToInterfaceEntity(d));
    }
  });

  // 获取所有字段
  node.fieldsArray.forEach(d => {
    const fieldname = d.name;
    rtn.properties[fieldname] = convertFieldToInterfacePropertyEntity(d);
  });
  return rtn;
}

export function convertToEnumEntity(node: pb.Enum): EnumEntity {
  return {
    name: node.name,
    properties: Object.keys(node.values).reduce(
      (rtn, acc) => {
        rtn[acc] = {
          value: node.values[acc],
          comment: '' // 暂时不要取 comment，comment 的解析比较死板，不准确
        };
        return rtn;
      },
      <{ [key: string]: EnumEntityMember }>{}
    )
  };
}

export function convertFieldToInterfacePropertyEntity(
  d: pb.Field
): InterfacePropertyEntity {
  return {
    comment: d.comment || '',
    defaultValue: '',
    index: d.id,
    type: typeMapping(d.type, d.repeated),
    optional: d.optional,
    required: d.required
  };
}

function printInterfaces(data: InterfaceEntity[]): string {
  const lines: string[] = [];
  data.forEach(datum => {
    if (datum.childrenEnums.length + datum.childrenInterfaces.length > 0) {
      lines.push(printInternalInterfacesAndEnums(datum));
    }
    lines.push(`export interface ${datum.name} {
    ${Object.keys(datum.properties)
      .map((key, i, arr) => {
        const property = datum.properties[key];
        return attachComment(
          `${key}${property.required ? '' : '?'}: ${property.type};`,
          property.comment,
          property.defaultValue
        );
      })
      .join('\n    ')}
  }

`);
  });
  return lines.join('');
}

export function convertServiceToServiceEntity(data: pb.Service): ServiceEntity {
  return {
    name: data.name,
    interfaces: data.methodsArray.reduce(
      (rtn, acc) => {
        rtn[acc.name] = convertMethodToFunctionEntity(acc);
        return rtn;
      },
      {} as ServiceEntity['interfaces']
    )
  };
}

export function printServices(data: ServiceEntity[]): string {
  return data.reduce((rtn, cur) => {
    rtn += `  export interface ${cur.name} {
${Object.keys(cur.interfaces)
  .map(key => {
    const i = cur.interfaces[key];
    let sortTmp: any[] = [];
    i.inputParams.forEach(d => (sortTmp[d.index] = d));
    sortTmp = sortTmp.filter(d => !!d);
    const inputParamsStr = (sortTmp as (typeof i)['inputParams'])
      .map(d => {
        const type = d.type;
        return `${d.name}: ${type}`;
      })
      .join(', ');
    const returnType = i.returnType;
    return attachComment(
      `    ${key}(${inputParamsStr}): Promise<${returnType}>;`,
      i.comment
    );
  })
  .join('\n')}
  }

`;
    return rtn;
  }, '');
}

export function isField(v: any): v is pb.Field {
  return v instanceof pb.Field;
}

export function crawlAstAndAttachNamespace(
  ast: pb.IParserResult,
  nodeMap: Map<string, PbNodeEntity[]>
) {
  (ast.root.lookup(ast.package!)! as pb.Namespace).nestedArray.forEach(d => {
    if (isMessage(d)) {
      d.fieldsArray.forEach(field => {
        if (
          !field.resolved &&
          !field.resolvedType &&
          !isOriginType(field.type)
        ) {
          // 优先取同命名空间下的 同名 Type
          // TODO: 由于 import 语句的文件取决于 protoc 的 proto_path 参数
          // 所以我们并不能确切定位未知类型到底属于哪个 namespace，只能先以策略
          // 形式去猜
          [ast.package! + '.' + field.type, field.type].some(fieldType => {
            const ff =
              fieldType.indexOf('.') !== -1 ? fieldType : `.${fieldType}`;
            for (const [ns, node] of nodeMap) {
              if (ns.indexOf(ff) === -1) {
                continue;
              }

              // 此时已找到 fullname 与 field.type 匹配的类型了，从 fullname 找 meta 信息匹配的类就行了
              const filteredData = node.filter(
                d =>
                  (d.type === 'enum' && d.meta.name === field.type) ||
                  (d.type === 'message' && d.meta.name === field.type)
              );
              if (!filteredData.length) {
                continue;
              }
              console.log(
                `${field.type} => ${filteredData[0].meta.fullName.replace(
                  /^\./,
                  ''
                )}`
              );
              field.type = filteredData[0].meta.fullName.replace(/^\./, '');
              return;
            }
          });
        }
      });
    }
  });
}

export function isOriginType(type: string) {
  return (
    [
      'double',
      'float',
      'int32',
      'int64',
      'uint32',
      'uint64',
      'sint32',
      'sint64',
      'fixed32',
      'fixed64',
      'sfixed32',
      'sfixed64',
      'bool',
      'bytes',
      'string',
      'list',
      'map'
    ].indexOf(type) !== -1
  );
}
