import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import express from 'express';
import axios from 'axios';
import qs from 'qs';
import crypto from 'crypto';
import twilio from 'twilio';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = 5000;

const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

const twilioClient = twilio(apiKey, apiKeySecret, { accountSid: accountSid });

const auth = {
  username: apiKey,
  password: apiKeySecret
}

const playerStreamerUrl = `https://media.twilio.com/v1/PlayerStreamers`;
const mediaProcessorUrl = `https://media.twilio.com/v1/MediaProcessors`;

app.use(express.json());

// Serve static files from the public directory
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile('public/index.html', { root: __dirname });
});

app.get('/stream', (req, res) => {
  res.sendFile('public/streamer.html', { root: __dirname });
});

app.get('/watch', (req, res) => {
  res.sendFile('public/audience.html', { root: __dirname });
});

/**
 * Start a new livestream with a Video Room, PlayerStreamer, and MediaProcessor
 */
app.post('/start', async (req, res) => {
  const streamName  = req.body.streamName;

  let roomId;
  let playerStreamerId;
  let mediaProcessorId;

  try {
    // Create the WebRTC Go video room, PlayerStreamer, and MediaProcessors
    const room = await twilioClient.video.rooms.create({
      uniqueName: streamName,
      type: 'go'
    });

    roomId = room.sid;

    const playerStreamerResponse = await axios({
      url: playerStreamerUrl,
      method: 'post',
      auth: auth
    });

    playerStreamerId = playerStreamerResponse.data.sid;

    const mediaProcessorData = {
      Extension: 'video-composer-v1-preview',
      ExtensionContext: JSON.stringify({
        room: {
          name: roomId
        },
        outputs: [playerStreamerId],
      })
    }

    const mediaProcessorResponse = await axios({
      url: mediaProcessorUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'post',
      auth: auth,
      data: qs.stringify(mediaProcessorData)
    });

    mediaProcessorId = mediaProcessorResponse.data.sid;

    return res.status(200).send({roomId, streamName, playerStreamerId, mediaProcessorId});

  } catch(error) {
    return res.status(400).send({
      message: `Unable to create livestream`,
      error
    });
  }
})

/**
 * End a livestream
 */
app.post('/end', async (req, res) => {
  const streamDetails = req.body.streamDetails;

  // End the player streamer, media processor, and video room
  const streamName  = streamDetails.streamName;
  const roomId  = streamDetails.roomId;
  const playerStreamerId = streamDetails.playerStreamerId;
  const mediaProcessorId = streamDetails.mediaProcessorId;

  try {
    const mediaProcessorResponse = await axios({
      url: `${mediaProcessorUrl}/${mediaProcessorId}`,
      method: 'post',
      auth: auth,
      data: qs.stringify({
        Status: 'ENDED',
      })
    });

    const playerStreamerResponse = await axios({
      url: `${playerStreamerUrl}/${playerStreamerId}`,
      method: 'post',
      auth: auth,
      data: qs.stringify({
        Status: 'ENDED',
      })
    });

    const completedRoom = await twilioClient.video.rooms(roomId).update({status: 'completed'});

    return res.status(200).send({
      message: `Successfully ended stream ${streamName}`
    });

  } catch (error) {
    return res.status(400).send({
      message: `Unable to end stream`,
      error
    })
  }
})

/**
 * Get an Access Token for a streamer
 */
app.post('/streamerToken', async (req, res) => {
  if (!req.body.identity || !req.body.room) {
    return res.status(400).send({ message: `Missing identity or stream name` });
  }

  // Get the user's identity and the room name from the request
  const identity  = req.body.identity;
  const roomName  = req.body.room;

  try {
    // Create a video grant for this specific room
    const videoGrant = new VideoGrant({
      room: roomName,
    });

    // Create an access token
    const token = new AccessToken(accountSid, apiKey, apiKeySecret);

    // Add the video grant and the user's identity to the token
    token.addGrant(videoGrant);
    token.identity = identity;

    // Serialize the token to a JWT and return it to the client side
    return res.send({
      token: token.toJwt()
    });

  } catch (error) {
    return res.status(400).send({error});
  }
});

/**
 * Get an Access Token for an audience member
 */
app.post('/audienceToken', async (req, res) => {
  // Generate a random string for the identity
  const identity = crypto.randomBytes(20).toString('hex');

  try {
    // Get the first player streamer
    const playerStreamerResponse = await axios({
      url: `${playerStreamerUrl}/?Status=STARTED`,
      method: 'get',
      auth: auth,
    });

    const playerStreamerList = playerStreamerResponse.data.player_streamers;
    const playerStreamer = playerStreamerList.length ? playerStreamerList[0] : null;

    // If no one is streaming, return a message
    if (!playerStreamer){
      res.status(200).send({
        message: `No one is streaming right now`,
      })
    }

    // Otherwise create a PlaybackGrant for the live stream
    const playerStreamerTokenResponse = await axios({
      url: `${playerStreamerUrl}/${playerStreamer.sid}/PlaybackGrant`,
      method: 'post',
      auth: auth,
      data: qs.stringify({
        Ttl: 60,
      })
    });

    const playbackGrant = playerStreamerTokenResponse.data.grant;

    // Create an access token
    const token = new AccessToken(accountSid, apiKey, apiKeySecret);

    // Add the playback grant and the user's identity to the token
    token.identity = identity;

    token.addGrant({
      key: 'player',
      player: playbackGrant,
      toPayload: () => playbackGrant,
    });

    // Serialize the token to a JWT and return it to the client side
    return res.send({
      token: token.toJwt()
    });
  } catch (error) {
    res.status(400).send({
      message: `Unable to view livestream`,
      error
    })
  }
})

// Start the Express server
app.listen(port, async () => {
  console.log(`Express server running on port ${port}`);
});