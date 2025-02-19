import { camel, pascal } from 'case';
import { ImportBuilder, ModuleBuilder } from './utils';
import { NamespacedZodOptions } from './types';
import { buildTypeName } from '@basketry/typescript/lib/name-factory';
import { buildParamsType } from '@basketry/typescript';
import {
  Enum,
  getHttpMethodByName,
  isRequired,
  Method,
  Parameter,
  Property,
  Type,
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

    for (const schema of sort(schemas)) {
      const { name, element } = schema;

      switch (element.kind) {
        case 'Type':
          yield `export const ${pascal(name)}Schema = ${z()}.object({`;
          for (const member of element.properties) {
            yield* this.buildMember(member, schema);
          }
          yield `});`;
          break;
        case 'Method':
          yield `export const ${pascal(name)}Schema = ${z()}.object({`;
          for (const member of element.parameters) {
            yield* this.buildMember(member, schema);
          }
          yield `});`;
          break;
        case 'PrimitiveUnion':
        case 'ComplexUnion':
        case 'DiscriminatedUnion': {
          const unionType =
            element.kind === 'DiscriminatedUnion'
              ? 'discriminatedUnion'
              : 'union';

          if (element.members.length === 1) {
            // If there is only one member, just export the schema for that member
            yield `export const ${pascal(name)}Schema = ${pascal(
              element.members[0].typeName.value,
            )}Schema;`;
          } else {
            yield `export const ${pascal(name)}Schema = ${z()}.${unionType}([`;

            if (element.kind === 'PrimitiveUnion') {
              // TODO: implement primitive unions
              yield `// Primitive unions are not yet supported`;
            } else {
              for (const member of element.members) {
                yield `${pascal(member.typeName.value)}Schema,`;
              }
            }

            yield `]);`;
          }
          break;
        }
        case 'Enum':
          yield `export const ${pascal(name)}Schema = ${z()}.enum([`;
          for (const member of element.members) {
            yield `  '${member.content.value}',`;
          }
          yield `]);`;
          break;
      }
      yield '';
    }
  }

  *buildMember(member: Parameter | Property, parent: Schema): Iterable<string> {
    const z = () => this.zod.fn('z');
    const name = camel(member.name.value);

    const shouldCoerce = () => {
      if (member.kind === 'Parameter' && parent.element.kind === 'Method') {
        const httpMethod = getHttpMethodByName(
          this.service,
          parent.element.name.value,
        );
        if (!httpMethod) return false;
        const httpParam = httpMethod?.parameters.find(
          (p) => camel(p.name.value) === camel(member.name.value),
        );
        if (!httpParam) return false;

        const location = httpParam?.location.value;

        return (
          location === 'header' || location === 'query' || location === 'path'
        );
      } else {
        return false;
      }
    };

    const schema: string[] = [];

    if (member.value.kind === 'PrimitiveValue') {
      switch (member.value.typeName.value) {
        case 'string': {
          const enumRule = member.value.rules.find(
            (r) => r.id === 'StringEnum',
          );

          if (member.value.constant) {
            schema.push(`${z()}.literal('${member.value.constant.value}')`);
          } else if (enumRule) {
            schema.push(
              `${z()}.enum(${enumRule.values
                .map((v) => `'${v.value}'`)
                .join(', ')})`,
            );
          } else {
            schema.push(`${z()}.string()`);

            const minLengthRule = member.value.rules.find(
              (r) => r.id === 'StringMinLength',
            );
            const maxLengthRule = member.value.rules.find(
              (r) => r.id === 'StringMaxLength',
            );
            const patternRule = member.value.rules.find(
              (r) => r.id === 'StringPattern',
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

          break;
        }
        case 'number':
        case 'integer':
        case 'long':
        case 'float':
        case 'double': {
          const coerce = shouldCoerce() ? `.coerce` : '';

          if (member.value.constant) {
            // TODO: support literal coercion
            schema.push(`${z()}.literal(${member.value.constant.value})`);
          } else {
            schema.push(`${z()}${coerce}.number()`);

            if (
              member.value.typeName.value === 'integer' ||
              member.value.typeName.value === 'long'
            ) {
              schema.push(`int()`);
            }

            const gtRule = member.value.rules.find((r) => r.id === 'NumberGT');
            const gteRule = member.value.rules.find(
              (r) => r.id === 'NumberGTE',
            );
            const ltRule = member.value.rules.find((r) => r.id === 'NumberLT');
            const lteRule = member.value.rules.find(
              (r) => r.id === 'NumberLTE',
            );
            const multipleOfRule = member.value.rules.find(
              (r) => r.id === 'NumberMultipleOf',
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

          break;
        }
        case 'boolean': {
          const coerce = shouldCoerce() ? `.coerce` : '';

          if (member.value.constant) {
            // TODO: support literal coercion
            schema.push(`${z()}.literal(${member.value.constant.value})`);
          } else {
            schema.push(`${z()}${coerce}.boolean()`);
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
      // TODO: support recursive types
      if (camel(member.value.typeName.value) === camel(parent.name)) {
        schema.push(
          `${z()}.lazy(()=>${pascal(member.value.typeName.value)}Schema)`,
        );
      } else {
        schema.push(`${pascal(member.value.typeName.value)}Schema`);
      }
    }

    if (member.value.isArray) {
      schema.push(`array()`);

      const minRule = member.value.rules.find((r) => r.id === 'ArrayMinItems');
      const maxRule = member.value.rules.find((r) => r.id === 'ArrayMaxItems');
      // TODO: support array-unique-items

      if (minRule) {
        if (minRule.min.value === 1) schema.push(`nonempty()`);
        else schema.push(`min(${minRule.min.value})`);
      }

      if (maxRule) schema.push(`max(${maxRule.max.value})`);
    }

    if (!isRequired(member.value)) {
      schema.push(`optional()`);
    }

    yield `${name}: ${schema.join('.')},`;
  }
}

function sort(iterable: Iterable<Schema>) {
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
          complexMembers = schema.element.properties
            .filter((p) => p.value.kind !== 'PrimitiveValue')
            .map((p) => pascal(p.value.typeName.value));
          break;
        case 'Method':
          complexMembers = schema.element.parameters
            .filter((p) => p.value.kind !== 'PrimitiveValue')
            .map((p) => pascal(p.value.typeName.value));
          break;
        case 'ComplexUnion':
        case 'DiscriminatedUnion':
          complexMembers = schema.element.members.map((m) =>
            pascal(m.typeName.value),
          );
          break;
        case 'PrimitiveUnion':
          // Primitive unions never have complex members
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
      console.error('Possible circular dependency detected');
      console.error(unsorted.map((s) => s.name));
      break;
    } else {
      prevUnsortedLength = unsorted.length;
    }
  }

  return sorted;
}

type Schema = {
  name: string;
  element: Type | Method | Union | Enum;
};
