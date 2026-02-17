console.log("[App] File loading...");
import * as React from 'react';
import { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { View, ActivityIndicator } from 'react-native';
import { supabase } from './lib/supabase';
import MapScreen from './screens/MapScreen';
import CameraScreen from './screens/CameraScreen';
import TimelapseScreen from './screens/TimelapseScreen';
import LoginScreen from './screens/LoginScreen';

import ManagementScreen from './screens/ManagementScreen';
import {
  useFonts,
  Montserrat_400Regular,
  Montserrat_600SemiBold,
  Montserrat_700Bold
} from '@expo-google-fonts/montserrat';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const BRAND_COLORS = {
  primary: '#667B53',
  dark: '#3C493A',
  light: '#B7D098',
  kiezel: '#F7EEE3',
  brown: '#5E462F',
  white: '#FFFFFF',
  black: '#000000',
};

function MapStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="MapMain" component={MapScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Timelapse" component={TimelapseScreen} options={{ title: 'Timelapse Viewer' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  const [session, setSession] = useState(null);

  const [fontsLoaded] = useFonts({
    'Montserrat-Regular': Montserrat_400Regular,
    'Montserrat-SemiBold': Montserrat_600SemiBold,
    'Montserrat-Bold': Montserrat_700Bold,
  });

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      console.log("[App] Checking session...");
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Session check timed out")), 5000)
      );

      try {
        const { data: { session } } = await Promise.race([
          supabase.auth.getSession(),
          timeoutPromise
        ]);
        console.log("[App] Session check complete:", session ? "Session found" : "No session");
        setSession(session);
      } catch (e) {
        console.error("[App] Session check error/timeout:", e);
        // On timeout or error, we assume no session to let the user see the login screen
        setSession(null);
      } finally {
        setLoading(false);
      }
    };

    checkSession();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("Auth Event:", event);
      if (session) console.log("Session detected for user:", session.user.email);
      setSession(session);
      setLoading(false);
    });

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, []);

  if (!fontsLoaded || loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: BRAND_COLORS.kiezel }}>
        <ActivityIndicator size="large" color={BRAND_COLORS.primary} />
      </View>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ focused, color, size }) => {
            let iconName;

            if (route.name === 'Kaart') {
              iconName = focused ? 'map' : 'map-outline';
            } else if (route.name === 'Camera') {
              iconName = focused ? 'camera' : 'camera-outline';
            } else if (route.name === 'Beheer') {
              iconName = focused ? 'settings' : 'settings-outline';
            }

            return <Ionicons name={iconName} size={size} color={color} />;
          },
          tabBarActiveTintColor: BRAND_COLORS.primary,
          tabBarInactiveTintColor: 'gray',
          tabBarStyle: {
            backgroundColor: BRAND_COLORS.white,
            borderTopColor: BRAND_COLORS.kiezel,
            paddingBottom: 5,
            height: 60,
          },
          tabBarLabelStyle: {
            fontFamily: 'Montserrat-SemiBold',
            fontSize: 10,
          },
          headerShown: false,
        })}
      >
        <Tab.Screen name="Kaart" component={MapStack} />
        <Tab.Screen name="Camera" component={CameraScreen} />
        <Tab.Screen name="Beheer" component={ManagementScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
