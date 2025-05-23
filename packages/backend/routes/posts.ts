import { Application, Request, Response } from 'express'
import { Op, Sequelize } from 'sequelize'
import {
  Blocks,
  Post,
  PostMentionsUserRelation,
  PostReport,
  ServerBlock,
  PostTag,
  User,
  Follows,
  UserLikesPostRelations,
  Media,
  Ask,
  Notification,
  UserEmojiRelation
} from '../db.js'
import { authenticateToken } from '../utils/authenticateToken.js'

import { sequelize } from '../db.js'

import getStartScrollParam from '../utils/getStartScrollParam.js'
import getPosstGroupDetails from '../utils/getPostGroupDetails.js'
import { logger } from '../utils/logger.js'
import { createPostLimiter, navigationRateLimiter } from '../utils/rateLimiters.js'
import { environment } from '../environment.js'
import { Queue } from 'bullmq'
import AuthorizedRequest from '../interfaces/authorizedRequest.js'
import optionalAuthentication from '../utils/optionalAuthentication.js'
import { getPetitionSigned } from '../utils/activitypub/getPetitionSigned.js'
import { getPostThreadRecursive } from '../utils/activitypub/getPostThreadRecursive.js'
import * as htmlparser2 from 'htmlparser2'
import checkIpBlocked from '../utils/checkIpBlocked.js'
import { getUnjointedPosts } from '../utils/baseQueryNew.js'
import * as cheerio from 'cheerio'
import getFollowedsIds from '../utils/cacheGetters/getFollowedsIds.js'
import { federatePostHasBeenEdited } from '../utils/activitypub/editPost.js'
import { getAvaiableEmojis } from '../utils/getAvaiableEmojis.js'
import { redisCache } from '../utils/redis.js'
import { getUserOptions } from '../utils/cacheGetters/getUserOptions.js'

import showdown from 'showdown'
import { forceUpdateLastActive } from '../utils/forceUpdateLastActive.js'
import { bulkCreateNotifications, createNotification } from '../utils/pushNotifications.js'
import { getAtProtoThread } from '../atproto/utils/getAtProtoThread.js'
import dompurify from 'isomorphic-dompurify'

const markdownConverter = new showdown.Converter({
  simplifiedAutoLink: true,
  literalMidWordUnderscores: true,
  strikethrough: true,
  simpleLineBreaks: true,
  openLinksInNewWindow: true,
  emoji: true,
  encodeEmails: false
})

const prepareSendPostQueue = new Queue('prepareSendPost', {
  connection: environment.bullmqConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnFail: 25000
  }
})
export default function postsRoutes(app: Application) {
  app.get(
    '/api/article/:user/:title',
    optionalAuthentication,
    navigationRateLimiter,
    async (req: AuthorizedRequest, res: Response) => {
      const userUrl = req.params?.user
      const postTitle = req.params?.title.replaceAll('-', ' ')
      const user = await User.findOne({
        where: {
          literal: sequelize.where(sequelize.fn('lower', sequelize.col('url')), userUrl.toLowerCase())
        }
      })
      if (!user) {
        res.sendStatus(404)
      } else {
        const postFound = await Post.findOne({
          where: {
            userId: user.id,
            literal: sequelize.where(sequelize.fn('lower', sequelize.col('title')), postTitle.toLowerCase())
          }
        })
        if (postFound) {
          res.redirect('/api/v2/post/' + postFound.id)
        } else {
          res.sendStatus(404)
        }
      }
    }
  )
  app.get(
    '/api/v2/post/:id',
    optionalAuthentication,
    navigationRateLimiter,
    async (req: AuthorizedRequest, res: Response) => {
      try {
        const userId = req.jwtData?.userId
        const postId = req.params?.id
        if (!postId) {
          return res.status(400).send({ success: false, errorMessage: 'No post id received' })
        }

        const unjointedPost = await getUnjointedPosts(
          [postId],
          userId ? userId : '00000000-0000-0000-0000-000000000000'
        )
        const post = unjointedPost.posts[0]
        if (!post) {
          return res.status(404).send({ success: false, errorMessage: 'Post not found' })
        }

        const mentions = unjointedPost.mentions.map((elem: any) => elem.userMentioned)
        const userCanSeePost = post.userId === userId || mentions.includes(userId) || post.privacy !== 10

        if (!userCanSeePost) {
          return res.status(403).send({ success: false, errorMessage: 'You are not authorized to read this post' })
        }

        return res.send(unjointedPost)
      } catch (err) {
        logger.error(err)
        return res.status(500).send({ success: false, errorMessage: 'Internal server error' })
      }
    }
  )

  /**
   * @deprecated We recomend instead using the forum endpoint. This method will not recive maintenance
   */
  app.get(
    '/api/v2/descendents/:id',
    optionalAuthentication,

    async (req: AuthorizedRequest, res: Response) => {
      const userId = req.jwtData?.userId ? req.jwtData.userId : '00000000-0000-0000-0000-000000000000'
      if (req.params?.id) {
        const posts = await Post.findOne({
          where: {
            id: req.params.id
          },
          attributes: [],
          include: [
            {
              model: Post,
              attributes: [
                'id',
                'userId',
                [sequelize.fn('LENGTH', sequelize.col('descendents.content')), 'len'],
                'createdAt',
                'updatedAt'
              ],
              as: 'descendents',
              where: {
                privacy: {
                  [Op.ne]: 10
                },
                [Op.or]: [
                  {
                    userId: userId
                  },
                  {
                    privacy: 1,
                    userId: {
                      [Op.in]: await getFollowedsIds(userId, false)
                    }
                  },
                  {
                    privacy: {
                      [Op.in]: [0, 2, 3]
                    }
                  }
                ]
              }
            }
          ]
        })
        const users = posts?.descendents?.length
          ? await User.findAll({
              attributes: ['url', 'avatar', 'name', 'id'],
              where: {
                id: {
                  [Op.in]: posts?.descendents.map((elem: any) => elem.userId)
                }
              }
            })
          : []
        res.send({
          posts: posts?.descendents?.length ? posts.descendents : [],
          users: users
        })
      } else {
        res.sendStatus(404)
      }
    }
  )
  app.get('/api/v2/blog', optionalAuthentication, async (req: AuthorizedRequest, res: Response) => {
    let success = false
    const id = req.query.id as string

    if (id) {
      const blog = await User.findOne({
        where: {
          [Op.or]: [sequelize.where(sequelize.fn('lower', sequelize.col('url')), id.toLowerCase()), { bskyDid: id }]
        }
      })

      if (!blog) {
        res.sendStatus(404)
        return
      }

      if (blog.url.startsWith('@') && !req.jwtData?.userId) {
        // require auth to see external user blog
        return res.sendStatus(403)
      }
      const blogId = blog?.id
      if (blogId) {
        const privacyArray = [0, 2, 3]
        if (
          req.jwtData?.userId === blogId ||
          (req.jwtData?.userId &&
            (await Follows.count({
              where: {
                followedId: blogId,
                followerId: req.jwtData?.userId,
                accepted: true
              }
            })))
        ) {
          privacyArray.push(1)
        }
        const postIds = await Post.findAll({
          order: [['createdAt', 'DESC']],
          limit: environment.postsPerPage,
          attributes: ['id'],
          where: {
            createdAt: { [Op.lt]: getStartScrollParam(req) },
            userId: blogId,
            privacy: {
              [Op.in]: privacyArray
            }
          }
        })
        const postsByBlog = await getUnjointedPosts(
          postIds.map((post: any) => post.id),
          req.jwtData?.userId ? req.jwtData.userId : '00000000-0000-0000-0000-000000000000'
        )
        success = true
        res.send(postsByBlog)
      }
    }

    if (!success) {
      res.send({ success: false })
    }
  })
  app.post(
    '/api/v3/createPost',
    authenticateToken,
    forceUpdateLastActive,
    createPostLimiter,
    async (req: AuthorizedRequest, res: Response) => {
      let success = false
      let mentionsToAdd: string[] = []
      const posterId = req.jwtData?.userId ? req.jwtData.userId : environment.deletedUser
      const posterUser = await User.findByPk(posterId)
      const postToBeQuoted = await Post.findByPk(req.body.postToQuote)
      try {
        const parent = await Post.findByPk(req.body.parent, {
          include: [
            {
              model: Post,
              as: 'ancestors'
            }
          ]
        })
        if (!parent && req.body.parent) {
          success = false
          res.status(500)
          res.send({ success: false, message: 'non existent parent' })
          return false
        }

        // we get the privacy of the parent and quoted post. Set body privacy to the max one
        const parentPrivacy: number = parent ? parent.privacy : 0
        let bodyPrivacy: number = req.body.privacy ? req.body.privacy : 0
        const quotedPostPrivacy: number = postToBeQuoted ? postToBeQuoted.privacy : 0
        bodyPrivacy = Math.max(parentPrivacy, bodyPrivacy, quotedPostPrivacy)
        // we check that the user is not reblogging a post by someone who blocked them or the other way arround
        if (parent) {
          // we check to add user mention if bsky id
          const ancestors = await parent.getAncestors({
            attributes: ['userId'],
            where: {
              bskyUri: {
                [Op.ne]: null
              },
              hierarchyLevel: {
                [Op.gt]: parent.hierarchyLevel - 3
              }
            }
          })
          if (req.body.content != '') {
            mentionsToAdd = mentionsToAdd.concat(ancestors.map((elem) => elem.userId))
            if (parent.bskyUri && parent.userId != posterId) {
              mentionsToAdd.push(parent.userId)
            }
          }

          const postParentsUsers: string[] = parent.ancestors.map((elem: any) => elem.userId)
          postParentsUsers.push(parent.userId)
          // we then check if the user has threads federation enabled and if not we check that no threads user is in the thread
          const options = await getUserOptions(posterId)
          const userFederatesWithThreads = options.filter(
            (elem) => elem.optionName === 'wafrn.federateWithThreads' && elem.optionValue === 'true'
          )
          if (userFederatesWithThreads.length === 0) {
            const ancestorPostsUsers = await User.findAll({
              where: {
                id: {
                  [Op.in]: postParentsUsers
                }
              }
            })
            const ancestorUrls: string[] = ancestorPostsUsers.map((elem: any) => elem.url.toLowerCase())
            if (ancestorUrls.some((elem) => elem.endsWith('threads.net'))) {
              success = false
              res.status(403)
              res.send({
                success: false,
                message: 'You do not federate with threads and this thread contains a post from threads'
              })
              return false
            }
          }

          const bannedUsers = await User.count({
            where: {
              id: {
                [Op.in]: postParentsUsers
              },
              banned: true
            }
          })
          // only count on reblogs
          const blocksExistingOnParents = parent
            ? await Blocks.count({
                where: {
                  [Op.or]: [
                    {
                      blockerId: posterId,
                      blockedId: parent.userId
                    },
                    {
                      blockedId: posterId,
                      blockerId: parent.userId
                    }
                  ]
                }
              })
            : 0
          if (blocksExistingOnParents + bannedUsers > 0) {
            success = false
            res.status(403)
            res.send({ success: false, message: 'You have no permission to reblog this post' })
            return false
          }
        }

        let content = req.body.content ? ' ' + req.body.content.trim() : ''
        const content_warning = req.body.content_warning
          ? req.body.content_warning.trim()
          : posterUser?.NSFW
          ? 'This user has been marked as NSFW and the post has been labeled automatically as NSFW'
          : ''
        let mediaToAdd: any[] = []
        const avaiableEmojis = await getAvaiableEmojis()
        // we parse the content and we search emojis:
        const emojisToAdd = avaiableEmojis?.filter((emoji: any) => req.body.content.includes(emoji.name))

        if (req.body.medias && req.body.medias.length) {
          mediaToAdd = req.body.medias
          // "not important" we update the media order
          const updateMediasPromises: Array<Promise<any>> = []
          Media.findAll({
            where: {
              id: {
                [Op.in]: mediaToAdd.map((media: any) => media.id)
              }
            }
          }).then((mediasToUpdate: Array<any>) => {
            mediaToAdd.forEach(async (media, index) => {
              const mediaToUpdate = mediasToUpdate.find((el: any) => el.id === media.id)
              if (mediaToUpdate) {
                mediaToUpdate.order = index
                mediaToUpdate.description = media.description
                mediaToUpdate.NSFW = media.NSFW
                await mediaToUpdate.save()
              }
            })
          })
        }

        const mentionRegex = /\s@[\w-\.]+@?[\w-\.]*/gm
        let mentionsInPost: string[] = content.match(mentionRegex)
        if (!mentionsInPost) {
          mentionsInPost = ['']
        }
        content = content.replaceAll(mentionRegex, (userUrl: string) => userUrl.toLowerCase())

        let dbFoundMentions: any[] = []
        const newMentionedUsers = req.body.mentionedUsersIds || []
        if (mentionsInPost?.length || newMentionedUsers.length) {
          const urlsToSearch = mentionsInPost.map((elem) => {
            // local users are stored without the @, so remove it from the query param
            let urlToSearch = elem.trim()
            if (urlToSearch.split('@').length == 2 && urlToSearch.split('.').length == 1) {
              urlToSearch = urlToSearch.split('@')[1]
            }
            // we sanitize the possible urls so we can use a literal
            return sequelize.escape(urlToSearch.toLowerCase().trim())
          })
          dbFoundMentions = await User.findAll({
            where: {
              [Op.or]: [
                {
                  literal: sequelize.literal(`lower("url") IN (${urlsToSearch.join(',')})`)
                },
                {
                  id: {
                    [Op.in]: newMentionedUsers
                  }
                }
              ]
            }
          })
        }

        if (dbFoundMentions.length > 0) {
          mentionsToAdd = mentionsToAdd.concat(dbFoundMentions.map((usr: any) => usr.id))

          // we check if user federates with threads and if not we check they are not mentioning anyone from threads
          const options = await getUserOptions(posterId)
          const userFederatesWithThreads = options.filter(
            (elem) => elem.optionName === 'wafrn.federateWithThreads' && elem.optionValue === 'true'
          )
          if (userFederatesWithThreads.length === 0) {
            if (dbFoundMentions.some((usr: any) => usr.url.toLowerCase().endsWith('threads.net'))) {
              success = false
              res.status(403)
              res.send({
                success: false,
                message: 'You do not federate with threads and this thread contains a post from threads'
              })
              return false
            }
          }
          const blocksExisting = await Blocks.count({
            where: {
              [Op.or]: [
                {
                  blockerId: posterId,
                  blockedId: { [Op.in]: mentionsToAdd }
                },
                {
                  blockedId: posterId,
                  blockerId: { [Op.in]: mentionsToAdd }
                }
              ]
            }
          })
          // TODO fix this
          const blocksServers = 0 /*await ServerBlock.count({
          where: {
            userBlockerId: posterId,
            literal: Sequelize.literal(
              `blockedServerId IN (SELECT federatedHostId from users where id IN (${  mentionsToAdd.map(
                (elem) => '"' + elem + '"'
              )}))`
            )
          }
        })*/
          if (blocksExisting + blocksServers > 0) {
            res.status(403)
            res.send({
              error: true,
              message: 'You can not mention an user that you have blocked or has blocked you'
            })
            return null
          }

          const sortedMentions = dbFoundMentions.sort((a: any, b: any) => a.url.length - b.url.length)
          for (let userMentioned of sortedMentions) {
            const url =
              !userMentioned.url.trim().startsWith('@') && userMentioned.url.split('.').length == 1
                ? `${userMentioned.url.trim()}`
                : userMentioned.url.split('@')[1].trim()
            const remoteId =
              userMentioned.url.split('@').length > 2
                ? userMentioned.remoteId
                : `${environment.frontendUrl}/fediverse/blog/${userMentioned.url}`
            const remoteUrl = userMentioned.remoteMentionUrl ? userMentioned.remoteMentionUrl : remoteId
            const stringToReplace = userMentioned.url.startsWith('@')
              ? userMentioned.url.toLowerCase()
              : `@${userMentioned.url.toLowerCase()}`
            const targetString = `<span class="h-card" translate="no"><a href="${remoteUrl}" class="u-url mention">@<span>${url}</span></a></span>`
            content = content.replace(`${stringToReplace}`, `${targetString}`).trim()
          }
        }

        content = markdownConverter.makeHtml(content.trim())
        let post: any
        content = content.trim()
        if (req.body.idPostToEdit) {
          post = await Post.findByPk(req.body.idPostToEdit)
          post.content = content
          post.markdownContent = req.body.content
          post.content_warning = content_warning
          post.privacy = bodyPrivacy
          await post.save()
        } else {
          if (req.body.parent) {
            await redisCache.del('postAndUser:' + req.body.parent)
          }
          post = await Post.create({
            content,
            content_warning,
            userId: posterId,
            privacy: bodyPrivacy,
            parentId: req.body.parent,
            markdownContent: req.body.content,
            isReblog: !!(
              parent &&
              content == '' &&
              !postToBeQuoted &&
              !req.body.ask &&
              mediaToAdd.length === 0 &&
              mentionsToAdd.length === 0 &&
              (req.body.tags ? req.body.tags.trim : '') == ''
            )
          })
        }

        if (post.isReblog) {
          await createNotification(
            {
              notificationType: 'REWOOT',
              notifiedUserId: parent?.userId,
              userId: post.userId,
              postId: parent?.id
            },
            {
              postContent: parent?.content,
              userUrl: posterUser?.url
            }
          )
        }
        if (postToBeQuoted) {
          if (req.body.idPostToEdit) {
            await Notification.destroy({
              where: {
                notificationType: 'QUOTE',
                notifiedUserId: postToBeQuoted.userId,
                userId: post.userId,
                postId: post.id
              }
            })
          }
          await post.addQuoted(postToBeQuoted)
          await PostMentionsUserRelation.findOrCreate({
            where: {
              postId: post.id,
              userId: postToBeQuoted.userId
            }
          })
          await createNotification(
            {
              notificationType: 'QUOTE',
              notifiedUserId: postToBeQuoted.userId,
              userId: post.userId,
              postId: post.id,
              createdAt: new Date(postToBeQuoted.createdAt)
            },
            {
              postContent: post.content,
              userUrl: posterUser?.url
            }
          )
        }
        const askId = req.body.ask
        if (askId) {
          const ask = await Ask.findOne({
            where: {
              id: parseInt(askId),
              userAsked: posterId
            }
          })
          if (ask) {
            ask.answered = true
            ask.postId = post.id
            if (ask.userAsker && !mentionsToAdd.includes(ask.userAsker)) {
              mentionsToAdd.push(ask.userAsker)
            }
            await ask.save()
          }
        }
        mentionsToAdd = [...new Set(mentionsToAdd)].filter((elem) => elem != posterId)
        post.setMedias(mediaToAdd.map((media: any) => media.id))
        post.setMentionPost(mentionsToAdd)
        if (req.body.idPostToEdit) {
          await Notification.destroy({
            where: {
              notificationType: 'MENTION',
              postId: post.id
            }
          })
        }

        await bulkCreateNotifications(
          mentionsToAdd.map((mention) => ({
            notificationType: 'MENTION',
            notifiedUserId: mention,
            userId: post.userId,
            postId: post.id,
            createdAt: new Date(post.createdAt)
          })),
          {
            postContent: post.content,
            userUrl: posterUser?.url
          }
        )

        post.setEmojis(emojisToAdd)
        const inlineTags = Array.from(dompurify.sanitize(post.content, { ALLOWED_TAGS: [] }).matchAll(/#[a-z0-9_]+/g))
          .join(',')
          .replaceAll('#', '')
        const bodyTags = req.body.tags ? req.body.tags + ',' + inlineTags : inlineTags
        success = !bodyTags
        if (bodyTags) {
          const tagListString = bodyTags
          let tagList: string[] = tagListString.split(',').filter((elem) => elem.length > 0)
          tagList = tagList.map((s: string) => s.trim())
          await PostTag.destroy({
            where: {
              postId: post.id
            }
          })
          await PostTag.bulkCreate(
            tagList.map((tag) => {
              return {
                tagName: tag,
                postId: post.id
              }
            })
          )

          success = true
        }
        res.send(post)
        await post.save()
        if (post.privacy.toString() !== '2') {
          if (req.body.idPostToEdit) {
            await federatePostHasBeenEdited(post)
          } else {
            await prepareSendPostQueue.add(
              'prepareSendPost',
              { postId: post.id, petitionBy: posterId },
              { jobId: post.id }
            )
          }
        }
      } catch (error) {
        logger.error(error)
      }
      if (!success) {
        res.statusCode = 400
        res.send({ success: false })
      }
    }
  )

  app.post('/api/reportPost', authenticateToken, async (req: AuthorizedRequest, res: Response) => {
    let success = false
    let report
    try {
      const posterId = req.jwtData?.userId
      if (req.body?.postId && req.body.severity && req.body.description) {
        report = await PostReport.create({
          resolved: false,
          severity: req.body.severity,
          description: req.body.description,
          userId: posterId,
          postId: req.body.postId
        })
        success = true
        res.send(report)
      }
    } catch (error) {
      logger.error(error)
    }
    if (!success) {
      res.send({
        success: false
      })
    }
  })

  app.get('/api/loadRemoteResponses', authenticateToken, async (req: AuthorizedRequest, res: Response) => {
    try {
      const userId = req.jwtData?.userId
      const postToGetRepliesFromId = req.query.id
      let remotePost = Post.findByPk(postToGetRepliesFromId)
      let user = User.findByPk(userId)
      await Promise.all([user, remotePost])
      user = await user
      remotePost = await remotePost
      if (remotePost.remotePostId) {
        // fedi post
        const postPetition = await getPetitionSigned(user, remotePost.remotePostId)
        if (postPetition) {
          if (postPetition.inReplyTo && remotePost.hierarchyLevel === 1) {
            const lostParent = await getPostThreadRecursive(user, postPetition.inReplyTo)
            await remotePost.setParent(lostParent)
          }
          // next replies to process
          let next = postPetition.replies.first
          while (next) {
            const petitions = next.items.map((elem: any) => getPostThreadRecursive(user, elem.id ? elem.id : elem))
            await Promise.allSettled(petitions)
            next = next.next ? await getPetitionSigned(user, next.next) : undefined
          }
        }
      }
      if (remotePost.bskyUri) {
        await getAtProtoThread(remotePost.bskyUri, undefined, true)
      }
    } catch (error) {
      logger.debug({ message: 'error getting external responses', post: req.query.id, error: error })
    }
    res.send({})
  })
}
