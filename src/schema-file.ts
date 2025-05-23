import { camel, pascal } from 'case';
import { ImportBuilder, ModuleBuilder } from './utils';
import { NamespacedZodOptions } from './types';
import { buildTypeName } from '@basketry/typescript/lib/name-factory';
import { buildParamsType } from '@basketry/typescript';
import {
  Enum,
  getHttpMethodByName,
  isRequired,
  MapKey,
  MapValue,
  Method,
  Parameter,
  Property,
  Type,
  TypedValue,
  Union,
} from 'basketry';

export class SchemaFile extends ModuleBuilder<NamespacedZodOptions> {
  private readonly zod = new ImportBuilder('zod');
  protected readonly importBuilders = [this.zod];

  *body(): Iterable<string> {
    const z = () => this.zod.fn('z');

    const schemas: Schema[] = [];

    for (const type of this.service.types) {
      schemas.push({ name: buildTypeName(type), element: type });
    }
    for (const method of this.service.interfaces.flatMap((i) => i.methods)) {
      if (method.parameters.length === 0) continue;

      schemas.push({
        name: Array.from(buildParamsType(method)).join(''),
        element: method,
      });
    }
    for (const union of this.service.unions) {
      schemas.push({ name: buildTypeName(union), element: union });
    }
    for (const e of this.service.enums) {
      schemas.push({ name: buildTypeName(e), element: e });
    }

    const { sorted, circular } = sort(schemas);

    for (const schema of sorted) {
      yield* this.buildSchema(schema, []);
      yield ``;
    }

    for (const schema of circular) {
      yield* this.buildSchema(schema, circular);
      yield ``;
    }
  }

  *buildSchema(schema: Schema, circular: Schema[]): Iterable<string> {
    const z = () => this.zod.fn('z');
    const { name, element } = schema;

    switch (element.kind) {
      case 'Type':
        const keySetName = ` __${camel(name)}Keys`;
        const keySchemaName = ` __${pascal(name)}KeySchema`;

        if (element.mapProperties?.key.rules.length) {
          if (element.properties.length) {
            yield `const ${keySetName} = new Set([${element.properties
              .map((p) => `'${p.name.value}'`)
              .join(', ')}]);`;
          }
          yield `const ${keySchemaName} = ${this.buildMemberSchema(
            element.mapProperties?.key,
            schema,
          )}`;
        }

        yield `export const ${pascal(name)}Schema = `;

        const maxPropCount = element.rules.find(
          (r) => r.id === 'object-max-properties',
        )?.max.value;
        let emittedPropCount = 0;

        if (
          element.properties.length ||
          element.mapProperties?.requiredKeys.length
        ) {
          yield `${z()}.object({`;
          for (const member of element.properties) {
            yield* this.buildMember(member, schema, circular);
            emittedPropCount++;
          }
          if (element.mapProperties) {
            for (const key of element.mapProperties.requiredKeys) {
              yield* this.buildRequiredKey(
                camel(key.value),
                element.mapProperties.value,
                schema,
                circular,
              );
              emittedPropCount++;
            }
          }
          yield `})`;

          if (
            element.mapProperties &&
            (typeof maxPropCount === 'undefined' ||
              maxPropCount > emittedPropCount)
          ) {
            yield `.catchall(${this.buildMemberSchema(
              element.mapProperties.value,
              schema,
            )})`;
          }
        } else if (element.mapProperties) {
          yield `${z()}.record(${this.buildMemberSchema(
            element.mapProperties.value,
            schema,
          )})`;
        } else {
          yield `${z()}.record(${z()}.any())`;
        }

        if (element.mapProperties) {
          const maxRule = element.rules.find(
            (r) => r.id === 'object-max-properties',
          );
          const minRule = element.rules.find(
            (r) => r.id === 'object-min-properties',
          );

          if (maxRule) {
            yield `.refine(`;
            yield `  data => Object.keys(data).length <= ${maxRule.max.value},`;
            yield `  { message: 'Object must have at most ${maxRule.max.value} keys' },`;
            yield `)`;
          }
          if (minRule) {
            yield `.refine(`;
            yield `  data => Object.keys(data).length >= ${minRule.min.value},`;
            yield `  { message: 'Object must have at least ${minRule.min.value} keys' },`;
            yield `)`;
          }
        }

        if (element.mapProperties) {
          const { key } = element.mapProperties;

          const schemaName = key.isPrimitive
            ? keySchemaName
            : `${pascal(key.typeName.value)}Schema`;

          if (key.rules.length || !key.isPrimitive) {
            yield `.superRefine((data, ctx) => {`;
            yield `  for (const key of Object.keys(data)) {`;
            if (element.properties.length) {
              yield `    if (${keySetName}.has(key)) continue;`;
              yield ``;
            }
            yield `    const result = ${schemaName}.safeParse(key);`;
            yield `    if (result.success) continue;`;
            yield ``;
            yield `    for (const error of result.error.errors) {`;
            yield `      ctx.addIssue({`;
            yield `        code: z.ZodIssueCode.custom,`;
            yield `        message: \`Invalid key: \${error.message}\`,`;
            yield `        path: [key],`;
            yield `      });`;
            yield `    }`;
            yield `  }`;
            yield `})`;
          }
        }

        break;
      case 'Method':
        yield `export const ${pascal(name)}Schema = ${z()}.object({`;
        for (const member of element.parameters) {
          yield* this.buildMember(member, schema, circular);
        }
        yield `});`;
        break;
      case 'Union':
        const complexMembers = element.members.filter((m) => !m.isPrimitive);

        if (complexMembers.length === 1) {
          // If there is only one member, just export the schema for that member
          yield `export const ${pascal(name)}Schema = ${pascal(
            complexMembers[0].typeName.value,
          )}Schema;`;
        } else {
          if (element.discriminator) {
            yield `export const ${pascal(
              name,
            )}Schema = ${z()}.discriminatedUnion('${camel(
              element.discriminator.value,
            )}', [`;
          } else {
            yield `export const ${pascal(name)}Schema = ${z()}.union([`;
          }

          for (const member of element.members) {
            if (member.isPrimitive) {
              yield `${this.buildMemberSchema(member, schema, {
                preventOptional: true,
              })},`;
            } else {
              yield `${pascal(member.typeName.value)}Schema,`;
            }
          }

          yield `]);`;
        }

        break;
      case 'Enum':
        yield `export const ${pascal(name)}Schema = ${z()}.enum([`;
        for (const member of element.values) {
          yield `  '${member.content.value}',`;
        }
        yield `]);`;
        break;
    }
  }

  *buildMember(
    member: Parameter | Property,
    parent: Schema,
    circular: Schema[],
  ): Iterable<string> {
    const name = camel(member.name.value);

    const schema = this.buildMemberSchema(member, parent, { circular });

    yield `${name}: ${schema},`;
  }

  *buildRequiredKey(
    name: string,
    value: MapValue,
    parent: Schema,
    circular: Schema[],
  ) {
    const schema = this.buildMemberSchema(value, parent, { circular });

    yield `${name}: ${schema},`;
  }

  buildMemberSchema(
    member: Parameter | Property | MapKey | MapValue | TypedValue,
    parent: Schema,
    options?: { preventOptional?: boolean; circular?: Schema[] },
  ): string {
    const z = () => this.zod.fn('z');

    const shouldCoerce = () => {
      if (
        hasKind(member) &&
        member.kind === 'Parameter' &&
        parent.element.kind === 'Method'
      ) {
        const httpMethod = getHttpMethodByName(
          this.service,
          parent.element.name.value,
        );
        if (!httpMethod) return false;
        const httpParam = httpMethod?.parameters.find(
          (p) => camel(p.name.value) === camel(member.name.value),
        );
        if (!httpParam) return false;

        const location = httpParam?.in.value;

        return (
          location === 'header' || location === 'query' || location === 'path'
        );
      } else {
        return false;
      }
    };

    const schema: string[] = [];

    if (member.isPrimitive) {
      switch (member.typeName.value) {
        case 'null':
          schema.push(`${z()}.literal(null)`);
          break;
        case 'string': {
          const enumRule = member.rules.find((r) => r.id === 'string-enum');

          if (member.constant) {
            schema.push(`${z()}.literal('${member.constant.value}')`);
          } else if (enumRule) {
            schema.push(
              `${z()}.enum(${enumRule.values
                .map((v) => `'${v.value}'`)
                .join(', ')})`,
            );
          } else {
            schema.push(`${z()}.string()`);

            const minLengthRule = member.rules.find(
              (r) => r.id === 'string-min-length',
            );
            const maxLengthRule = member.rules.find(
              (r) => r.id === 'string-max-length',
            );
            const patternRule = member.rules.find(
              (r) => r.id === 'string-pattern',
            );

            if (
              minLengthRule &&
              minLengthRule.length.value === maxLengthRule?.length.value
            ) {
              schema.push(`length(${minLengthRule.length.value})`);
            } else {
              if (minLengthRule)
                if (minLengthRule.length.value === 1) schema.push(`nonempty()`);
                else schema.push(`min(${minLengthRule.length.value})`);
              if (maxLengthRule)
                schema.push(`max(${maxLengthRule.length.value})`);
            }

            if (patternRule) {
              schema.push(`regex(/${patternRule.pattern.value}/)`);
            }
          }

          if (member.default) {
            schema.push(`default('${member.default.value}')`);
          }

          break;
        }
        case 'number':
        case 'integer':
        case 'long':
        case 'float':
        case 'double': {
          const coerce = shouldCoerce() ? `.coerce` : '';

          if (member.constant) {
            // TODO: support literal coercion
            schema.push(`${z()}.literal(${member.constant.value})`);
          } else {
            schema.push(`${z()}${coerce}.number()`);

            if (
              member.typeName.value === 'integer' ||
              member.typeName.value === 'long'
            ) {
              schema.push(`int()`);
            }

            const gtRule = member.rules.find((r) => r.id === 'number-gt');
            const gteRule = member.rules.find((r) => r.id === 'number-gte');
            const ltRule = member.rules.find((r) => r.id === 'number-lt');
            const lteRule = member.rules.find((r) => r.id === 'number-lte');
            const multipleOfRule = member.rules.find(
              (r) => r.id === 'number-multiple-of',
            );

            if (gtRule) {
              if (gtRule.value.value === 0) schema.push(`positive()`);
              else schema.push(`gt(${gtRule.value.value})`);
            }
            if (gteRule) {
              if (gteRule.value.value === 0) schema.push(`nonnegative()`);
              else schema.push(`gte(${gteRule.value.value})`);
            }
            if (ltRule) {
              if (ltRule.value.value === 0) schema.push(`negative()`);
              else schema.push(`lt(${ltRule.value.value})`);
            }
            if (lteRule) {
              if (lteRule.value.value === 0) schema.push(`nonpositive()`);
              else schema.push(`lte(${lteRule.value.value})`);
            }
            if (multipleOfRule) {
              schema.push(`multipleOf(${multipleOfRule.value.value})`);
            }
          }

          if (member.default) {
            schema.push(`default(${member.default.value})`);
          }

          break;
        }
        case 'boolean': {
          const coerce = shouldCoerce() ? `.coerce` : '';

          if (member.constant) {
            // TODO: support literal coercion
            schema.push(`${z()}.literal(${member.constant.value})`);
          } else {
            schema.push(`${z()}${coerce}.boolean()`);
          }

          if (member.default) {
            schema.push(`default(${member.default.value})`);
          }

          break;
        }
        case 'date':
        case 'date-time':
          // Always coerce dates
          schema.push(`${z()}.coerce.date()`);
          break;
        case 'binary':
        case 'untyped':
          schema.push(`${z()}.any()`);
          break;
      }
    } else {
      if (
        camel(member.typeName.value) === camel(parent.name) ||
        options?.circular?.some(
          (s) => camel(s.name) === camel(member.typeName.value),
        )
      ) {
        schema.push(`${z()}.lazy(()=>${pascal(member.typeName.value)}Schema)`);
      } else {
        schema.push(`${pascal(member.typeName.value)}Schema`);
      }
    }

    if (member.isArray) {
      schema.push(`array()`);

      const minRule = member.rules.find((r) => r.id === 'array-min-items');
      const maxRule = member.rules.find((r) => r.id === 'array-max-items');
      // TODO: support array-unique-items

      if (minRule) {
        if (minRule.min.value === 1) schema.push(`nonempty()`);
        else schema.push(`min(${minRule.min.value})`);
      }

      if (maxRule) schema.push(`max(${maxRule.max.value})`);
    }

    if (
      !isRequired(member) &&
      (!hasKind(member) ||
        (member.kind !== 'MapKey' && member.kind !== 'MapValue'))
    ) {
      if (
        !options?.preventOptional &&
        (!member.isPrimitive || !member.default)
      ) {
        schema.push(`optional()`);
      }
    }

    return schema.join('.');
  }
}

function sort(iterable: Iterable<Schema>): {
  sorted: Schema[];
  circular: Schema[];
} {
  const sorted: Schema[] = [];
  let unsorted: Schema[] = Array.from(iterable);

  const sortedNames = new Set<string>();

  let prevUnsortedLength = unsorted.length;

  while (unsorted.length > 0) {
    const unsortable: Schema[] = [];
    const sortable: Schema[] = [];

    const newlySortedNames = new Set<string>();

    for (const schema of unsorted) {
      let complexMembers: string[] = [];

      switch (schema.element.kind) {
        case 'Type':
          const propertyMembers = schema.element.properties
            .filter((p) => !p.isPrimitive)
            .map((p) => pascal(p.typeName.value));

          const mapKeyMembers =
            schema.element.mapProperties?.key.isPrimitive === false
              ? [pascal(schema.element.mapProperties.key.typeName.value)]
              : [];

          const mapValueMembers =
            schema.element.mapProperties?.value.isPrimitive === false
              ? [pascal(schema.element.mapProperties.value.typeName.value)]
              : [];

          complexMembers = [
            ...propertyMembers,
            ...mapKeyMembers,
            ...mapValueMembers,
          ];
          break;
        case 'Method':
          complexMembers = schema.element.parameters
            .filter((p) => !p.isPrimitive)
            .map((p) => pascal(p.typeName.value));
          break;
        case 'Union':
          complexMembers = schema.element.members
            .filter((m) => !m.isPrimitive)
            .map((m) => pascal(m.typeName.value));
          break;
        case 'Enum':
          // Enums never have complex members
          break;
      }

      if (
        complexMembers.length === 0 ||
        complexMembers.every((n) => sortedNames.has(n) || n === schema.name)
      ) {
        sortable.push(schema);
        newlySortedNames.add(schema.name);
      } else {
        unsortable.push(schema);
      }
    }

    const sortedSortable = [...sortable].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    sorted.push(...sortedSortable);
    for (const name of newlySortedNames) sortedNames.add(name);
    unsorted = unsortable;

    if (prevUnsortedLength === unsorted.length) {
      // No progress was made, so we return the unsorted items as circular dependencies.
      return { sorted, circular: unsorted };
    } else {
      prevUnsortedLength = unsorted.length;
    }
  }

  return { sorted, circular: [] };
}

type Schema = {
  name: string;
  element: Type | Method | Union | Enum;
};

function hasKind(
  member: Parameter | Property | MapKey | MapValue | TypedValue,
): member is Parameter | Property | MapKey | MapValue {
  return 'kind' in member;
}
