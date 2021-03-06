import express from 'express';
import moment from 'moment';
import async from 'async';
import {
    UsaStates
} from 'usa-states';
import validator from 'validator';
import {
    isAuthenticated
} from '../utils/passport';

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({
    path: path.join(__dirname, '../../.env')
});

import User from '../models/User';
import DashboardUser from '../models/DashboardUser';
import Bundle from '../models/Bundle';

import discord from '../utils/discord';

const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_PRIVATE_KEY);

router.get('/profile', isAuthenticated, async (req, res, next) => {

    const usStates = new UsaStates();

    let general = {};

    if (!req.user.identifier) return next();

    User.findById(req.user.identifier).populate('bundle').exec((err, user) => {
        if (!user) return next();
        general.key = user.key;
        general.membership = user.bundle.title;
        general.email = user.email;
        general.nextBillingDate = 'N/A';
        general.cancel_at_period_end = null;
        if (user.subscriptionID.startsWith('sub_')) {
            stripe.subscriptions.retrieve(user.subscriptionID, (err, subscription) => {
                if (subscription) {
                    async.waterfall([
                        function (callback) {
                            stripe.subscriptions.retrieve(user.subscriptionID, (err, subscription) => {
                                if (subscription) {
                                    general.cancel_at_period_end = subscription.cancel_at_period_end;
                                    callback(null, moment.unix(subscription.current_period_end).format('LL'), subscription.customer);
                                } else {
                                    callback(err, null);
                                }
                            });
                        },
                        function (endDate, customerID, callback) {
                            stripe.customers.retrieve(customerID, (err, customer) => {
                                if (customer) {
                                    callback(null, {
                                        customer: customer,
                                        endDate: endDate
                                    });
                                } else {
                                    callback(err, null);
                                }
                            });
                        }
                    ], async (err, result) => {
                        general.nextBillingDate = result.endDate;
                        general.customer = result.customer;
                        const subData = await stripe.subscriptions.retrieve(user.subscriptionID);
                        general.status = subData.status.charAt(0).toUpperCase() + subData.status.slice(1);

                        return res.render('users/profile', {
                            'publishable_key': process.env.STRIPE_PUBLIC_KEY,
                            'general': general,
                            'states': usStates.states
                        });
                    });
                } else {
                    return res.render('users/profile', {
                        'publishable_key': process.env.STRIPE_PUBLIC_KEY,
                        'general': general,
                        'states': usStates.states
                    });
                }
            });
        } else {
            return res.render('users/profile', {
                'publishable_key': process.env.STRIPE_PUBLIC_KEY,
                'general': general,
                'states': usStates.states
            });
        }
    });

});

router.get('/profile', isAuthenticated, async (req, res) => {
    if (req.user.identifier) {
        DashboardUser.findById(req.user._id, (err, b_user) => {
            b_user.identifier = null;
            b_user.save(() => {
                return res.render('users/redeem');
            });
        });
    } else {
        return res.render('users/redeem');
    }
});


router.post('/redeem', isAuthenticated, async (req, res) => {
    const key = req.body['license'];
    let roles = [];
    let identifier = null;
    User.findOne({
        key: key
    }, async (err, user) => {
        if (!err && user) {
            identifier = user._id;
            try {
                let existingUser = await DashboardUser.findOne({
                    identifier: identifier
                }).exec();
                if (existingUser) {
                    return res.send('This key is already activated on anothers users account.')
                } else {
                    DashboardUser.findOne({
                        _id: req.user._id
                    }, (err, b_user) => {
                        if (!err && b_user) {
                            b_user.identifier = identifier;
                            b_user.save(() => {
                                return res.redirect('/users/activate');
                            });
                        } else {
                            return res.send('Error occured while trying to fetch your porfile information.')
                        }
                    });
                }
            } catch (err) {
                return res.send('An unknown error has occured while trying to redeem your key.')
            }

        } else {
            return res.send('Invalid key, please try again.');
        }
    });
});

router.post('/profile/update/billing', isAuthenticated, async (req, res) => {

    User.findById(req.user.identifier, (err, user) => {
        if (err || !user) {
            return res.redirect('/users/profile');
        } else {
            if (req.body.stripeToken) {
                /* Change entire stripe source */
                stripe.subscriptions.retrieve(user.subscriptionID, (err, subscription) => {
                    if (subscription) {
                        stripe.customers.createSource(
                            subscription.customer, {
                                source: req.body.stripeToken
                            },
                            (err, source) => {
                                if (err) {
                                    return res.redirect('/users/profile');
                                } else {

                                    stripe.customers.retrieve(subscription.customer, (err, customer) => {
                                        if (err || !customer) {
                                            return res.redirect('/users/profile');
                                        } else {
                                            const default_source = customer.default_source;
                                            stripe.customers.update(subscription.customer, {
                                                default_source: source.id
                                            }, (err, customer) => {
                                                if (err) {
                                                    console.error('Stripe Customer Update Error:', err);
                                                    return res.redirect('/users/profile');
                                                }
                                                /* Delete Old Source */
                                                stripe.customers.deleteSource(
                                                    subscription.customer,
                                                    default_source,
                                                    (err, source) => {
                                                        if (err) {
                                                            return res.redirect('/users/profile');
                                                        }
                                                        return res.redirect('/users/profile');
                                                    });
                                            });

                                        }
                                    });
                                }
                            });
                    } else {
                        return res.redirect('/users/profile');
                    }
                });
            } else {
                stripe.subscriptions.retrieve(user.subscriptionID, (err, subscription) => {
                    if (subscription) {
                        stripe.customers.retrieve(subscription.customer, (err, customer) => {
                            if (err || !customer) {
                                return res.redirect('/users/profile');
                            } else {
                                const default_source = customer.default_source;
                                let sourceChanges = {
                                    name: req.body['name'],
                                    address_line1: req.body['address_line1'],
                                    address_city: req.body['address_city'],
                                    address_zip: req.body['address_zip'],
                                    address_state: req.body['address_state']
                                }
                                stripe.customers.updateCard(
                                    subscription.customer,
                                    default_source,
                                    sourceChanges,
                                    function (err, card) {
                                        if (err || !card) {
                                            return res.redirect('/users/profile');
                                        } else {
                                            return res.redirect('/users/profile');
                                        }
                                    }
                                );

                            }
                        });
                    }
                });
            }
        }

    });
});

router.get('/deactivate', (req, res) => {
    let oldIdentifier = null;
    DashboardUser.findOne({
        _id: req.user._id
    }, (err, user) => {
        /* TODO: Remove user from Discord if they're still in it */
        oldIdentifier = user.identifier;
        user.identifier = null;
        user.save(() => {
            /* Make Discord ID null in main database */
            User.findOne({
                _id: oldIdentifier
            }, (err, db_user) => {
                db_user.discordID = null;
                db_user.save(() => {
                    discord.removeFromGuild(process.env.DISCORD_BOT_TOKEN, process.env.GUILD_ID, req.user.discordID, (err, body) => {
                        return res.redirect('/');
                    });
                });
            });
        });
    });
});

router.get('/activate', (req, res) => {
    if (req.user.identifier) {
        User.findById(req.user.identifier).populate('bundle').exec(async (err, user) => {
            if (user.exempt) {
                discord.inviteToGuild(process.env.DISCORD_BOT_TOKEN, process.env.GUILD_ID, req.user.discordID, req.user.accessToken, user.bundle.roles, (err, body) => {
                    return res.redirect('/');
                });
            } else if (user.subscriptionID.indexOf('sub_') > -1) {
                try {
                    const subData = await stripe.subscriptions.retrieve(user.subscriptionID);
                    if (subData.status == 'active') {
                        discord.inviteToGuild(process.env.DISCORD_BOT_TOKEN, process.env.GUILD_ID, req.user.discordID, req.user.accessToken, user.bundle.roles, (err, body) => {
                            return res.redirect('/');
                        });
                    } else {
                        return res.redirect('/');
                    }
                } catch (e) {
                    return res.redirect('/');
                }
            } else {
                return res.redirect('/');
            }
        });
    } else {
        return res.redirect('/');
    }
});

router.get('/cancel', (req, res) => {
    User.findById(req.user.identifier, async (err, user) => {
        if (!err && user) {
            if (user.exempt) return res.send('Whoops you dont have the permissions to do this.');
            try {
                await stripe.subscriptions.del(user.subscriptionID, {
                    at_period_end: true
                })
                return res.redirect('/');
            } catch (e) {
                return res.send('An error has occured while trying to cancel your subscription.');
            }
        } else {
            return res.send('Whoops you dont have the permissions to do this.');
        }
    });
});

router.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

export default router;