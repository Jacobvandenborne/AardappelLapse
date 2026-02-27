import React, { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, Alert, Dimensions, Image } from 'react-native';
import { supabase } from '../lib/supabase';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';

WebBrowser.maybeCompleteAuthSession();

const { width } = Dimensions.get('window');

export default function LoginScreen() {
    const [loading, setLoading] = useState(false);

    const handleGoogleLogin = async () => {
        setLoading(true);
        console.log("Starting Google Login via Supabase...");

        try {
            const redirectUrl = AuthSession.makeRedirectUri({
                scheme: 'aardappellapse',
                path: 'google-auth',
            });
            console.log("Redirect URL being used:", redirectUrl);

            const { data, error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUrl,
                    skipBrowserRedirect: true,
                    scopes: 'openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
                },
            });

            if (error) throw error;

            if (data?.url) {
                const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);
                console.log("WebBrowser Result Type:", result.type);

                if (result.type === 'success' && result.url) {
                    console.log("Result URL found, parsing tokens...");

                    // Manually parse tokens from URL (they are often in the # fragment)
                    const urlParts = result.url.split('#');
                    const hash = urlParts.length > 1 ? urlParts[1] : (result.url.split('?')[1] || "");

                    if (hash) {
                        const params = Object.fromEntries(
                            hash.split('&').map(part => part.split('='))
                        );

                        const access_token = params.access_token;
                        const refresh_token = params.refresh_token;
                        const provider_token = params.provider_token; // Captured for Google Drive API

                        if (access_token && refresh_token) {
                            console.log("Tokens extracted, setting session...");

                            // If we have a provider_token, we should store it for Drive access
                            // Supabase setSession handles the Supabase auth, but we might need 
                            // to store the provider_token separately if Supabase doesn't persist it in a way we can easily fetch.
                            // Supabase DOES return it in the session object usually.

                            const { error: sessionError } = await supabase.auth.setSession({
                                access_token,
                                refresh_token,
                            });
                            if (sessionError) throw sessionError;

                            if (provider_token) {
                                console.log("Google Provider Token captured!");
                                // Optionally store for immediate use or via a secure storage helper
                            }

                            console.log("Session set successfully!");
                        } else {
                            console.log("No tokens found in URL fragment. Params:", params);
                        }
                    } else {
                        console.log("No hash or query params found in redirect URL:", result.url);
                    }
                }
            }
        } catch (error) {
            console.error("Auth Error:", error);
            Alert.alert('Inlog Fout', `Er is een probleem: ${error.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Image
                    source={require('../assets/logo.png')}
                    style={styles.logo}
                    resizeMode="contain"
                />
                <Text style={styles.title}>VDBORNE</Text>
                <Text style={styles.subtitle}>AARDAPPEL-LAPSE</Text>
            </View>

            <View style={styles.content}>
                <Text style={styles.welcomeText}>
                    Welkom bij het timelapse beheer portaal. Log in met je werk-account om verder te gaan.
                </Text>

                <TouchableOpacity
                    style={styles.googleButton}
                    onPress={handleGoogleLogin}
                    disabled={loading}
                >
                    {loading ? (
                        <ActivityIndicator color="white" />
                    ) : (
                        <>
                            <Ionicons name="logo-google" size={20} color="white" />
                            <Text style={styles.buttonText}>INLOGGEN MET GMAIL</Text>
                        </>
                    )}
                </TouchableOpacity>

                <Text style={styles.footerText}>
                    Alleen geautoriseerde Gmail-accounts van Van den Borne hebben toegang.
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F7EEE3', // Kiezel
        justifyContent: 'center',
        alignItems: 'center',
    },
    header: {
        alignItems: 'center',
        marginBottom: 40,
    },
    logo: {
        width: 120,
        height: 120,
        marginBottom: 20,
    },
    title: {
        fontSize: 32,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 2,
        color: '#000000',
    },
    subtitle: {
        fontSize: 14,
        fontFamily: 'Montserrat-Regular',
        color: '#3C493A', // Donkergroen
        letterSpacing: 4,
        marginTop: 5,
    },
    content: {
        width: width * 0.85,
        backgroundColor: 'white',
        padding: 30,
        borderRadius: 15,
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
        alignItems: 'center',
    },
    welcomeText: {
        fontSize: 15,
        fontFamily: 'Montserrat-Regular',
        color: '#5E462F', // Donkerbruin
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 30,
    },
    googleButton: {
        flexDirection: 'row',
        backgroundColor: '#667B53', // Brand Green
        width: '100%',
        paddingVertical: 18,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 2,
    },
    buttonText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 14,
        letterSpacing: 1,
        marginLeft: 12,
    },
    footerText: {
        fontSize: 11,
        fontFamily: 'Montserrat-Regular',
        color: '#3C493A',
        marginTop: 25,
        textAlign: 'center',
        opacity: 0.7,
    },
});
