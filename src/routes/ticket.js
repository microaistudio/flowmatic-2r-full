const express = require('express');

const router = express.Router();

const DEPRECATION_MESSAGE =
    'This ticket endpoint is deprecated. Use /api/terminal/call-next and related terminal routes.';

function rejectLegacyTicketRoute(req, res) {
    res.status(410).json({ error: DEPRECATION_MESSAGE });
}

router.post('/state', rejectLegacyTicketRoute);
router.post('/requeue', rejectLegacyTicketRoute);
router.post('/recycle', rejectLegacyTicketRoute);
router.post('/park', rejectLegacyTicketRoute);
router.post('/no-show', rejectLegacyTicketRoute);

module.exports = router;
