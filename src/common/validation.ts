import { Ajv, ErrorObject, JSONSchemaType } from 'ajv';

const GENERAL_VALIDATION_ERROR = 'invalid content';

const ajv = new Ajv({ allErrors: true });

interface ValidationResponse<T> {
  isValid: boolean;
  errors?: string | ErrorObject<string, Record<string, unknown>>[];
  content?: T;
}

function validate<T>(content: unknown, schema: JSONSchemaType<T>): ValidationResponse<T> {
  const isValid = ajv.validate(schema, content);

  if (!isValid) {
    const errors = ajv.errors ?? GENERAL_VALIDATION_ERROR;
    return { isValid, errors };
  }

  return { isValid, content };
}

export { validate, type ValidationResponse };
