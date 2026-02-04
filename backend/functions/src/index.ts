import { app } from '@azure/functions';

app.setup({ enableHttpStream: true });

import './functions/netsfereWebhook';
import './functions/consultsList';
import './functions/consultsGet';
import './functions/consultVoiceToken';
import './functions/consultVoiceInput';
import './functions/consultVoiceListen';
import './functions/consultVoiceSend';