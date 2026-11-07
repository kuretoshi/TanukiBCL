import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../../common/clientPeerConfigSchema.json';

const ajv = new Ajv({
	allErrors: true,
	strict: false,
});
addFormats(ajv);

export const validateClientPeerConfig = ajv.compile(schema);
